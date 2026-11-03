#!/usr/bin/env bash
# Round 24b scenario H — multi-session long-term memory CORRECTNESS on the real
# model (task pack P1-1; checks U13–U24 in ci-check.py). Called by ci-e2e.sh
# (runnable alone with the env.sh environment and OPENCODE_API_KEY).
#
# Every `run` is a fresh `dsh` process, so each step below is also a restart.
#   h-f1…f4  session A records four independent facts (architecture decision,
#            user constraint, file relation, todo), one user message each, each
#            with a unique codeword, and pins each one with ctx_memory
#   h-a2…    file-read turns on the 40k route until the historian has published
#            compartments in at least two separate passes (shipped 65 % threshold)
#   h-aq     restart; ctx_search for one codeword (message lane: right message +
#            ordinal, possibly folded into its compartment) and ctx_expand of
#            that hit's range (the ORIGINAL sentence)
#   h-as     ctx_search with a paraphrase that shares no codeword (compartment /
#            semantic lane: the compartment covering the fact)
#   h-ad     embedding endpoint unreachable for one run: ctx_search still answers
#            from full-text and says so visibly (degrade, no error)
#   h-b1     NEW session B: the four facts asked in different words
#   h-b2     restart; the todo is replaced (old one cancelled) via ctx_memory
#   h-c1     NEW session C: the current todo (must be the NEW one)
#   h-c2     ctx_search "open todo codeword" in C (new value, no stale memory,
#            no session-A message leaking into C's history lanes)
#   h-c3     a fact that was never recorded (must not invent a codeword)
# Embeddings: CI has no local embedding model, so the scenario points the user
# jsonc at embed-mock.mjs (deterministic bag-of-words openai-compatible
# endpoint) and restores the file afterwards.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/ci}"
DB="$XDG_DATA_HOME/cortexkit/magic-context/context.db"
mkdir -p "$OUT"
touch "$OUT/runs.tsv"

session_of() { python3 - "$1" <<'PY'
import json, sys
for line in open(sys.argv[1], errors="replace"):
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get("type") == "session":
        print(o.get("sessionId", "")); break
PY
}
run() {
  local name="$1" task="$2" sid="${3:-}" log
  bash "$HERE/run-headless.sh" "$task" ${sid:+"$sid"} > "$OUT/$name.out" 2>&1
  log="$(tail -n 1 "$OUT/$name.out" | sed -n 's/.*log=//p')"
  if [[ -n "$log" && -f "$log" ]]; then cp "$log" "$OUT/$name.log"; else cp "$OUT/$name.out" "$OUT/$name.log"; fi
  printf '%s\t%s\t%s\n' "$name" "$(session_of "$OUT/$name.log")" "$(tail -n 1 "$OUT/$name.out")" >> "$OUT/runs.tsv"
  echo "[ci-h] $name: $(tail -n 1 "$OUT/$name.out")"
}

ARCH="ARCH-KESTREL-4127"; RULE="RULE-MARMOT-5830"; FILE="FILE-HERON-2261"; TODO="TODO-BISON-9074"; TODO2="TODO-YAK-3318"
CODES="$ARCH,$RULE,$FILE,$TODO,$TODO2"
F_ARCH="Architecture decision: every write to the ledger goes through the outbox saga, which is the single writer (codeword $ARCH)."
F_RULE="User constraint: never run database migrations from a background worker (codeword $RULE)."
F_FILE="File relation: the quota gauge module src/host/meter.ts takes its figures from src/host/context-details.ts (codeword $FILE)."
F_TODO="Open todo: add a pruning job for stale historian leases (codeword $TODO)."
printf '%s\n' "$F_ARCH" "$F_RULE" "$F_FILE" "$F_TODO" > "$OUT/h-facts.txt"
hdump() { [[ -f "$DB" ]] && bun "$HERE/ci-h.ts" "$DB" "$CODES" "$1" > "$OUT/h-db-$2.json" 2>/dev/null; }
ncomp() { python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1])); s=d["sessions"][sys.argv[2]]; c=s.get("compartments"); print(len(c) if isinstance(c,list) else 0)
except Exception: print(0)' "$OUT/h-db-$1.json" "$2"; }
nmem() { python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1])); print(len({c for m in (d.get("memories") or []) if m.get("status","active")=="active" for c in m["codes"]}))
except Exception: print(0)' "$OUT/h-db-$1.json"; }

# --- embedding: deterministic mock endpoint for this scenario only
CFG="$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc"
cp "$CFG" "$OUT/h-jsonc.orig"
export EMBED_MOCK_PORT="${EMBED_MOCK_PORT:-18578}"
: > "$OUT/h-embed-requests.jsonl"
node "$HERE/embed-mock.mjs" "$EMBED_MOCK_PORT" "$OUT/h-embed-requests.jsonl" > "$OUT/h-embed-mock.log" 2>&1 &
EMBED_PID=$!
hcfg() { python3 - "$CFG" "$1" <<'PY'
import json, sys
path, endpoint = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
head = [l for l in lines if l.lstrip().startswith("//")]
cfg = json.loads("\n".join(l for l in lines if not l.lstrip().startswith("//")))
cfg["embedding"] = {"provider": "openai-compatible", "endpoint": endpoint, "model": "bow-mock-256"}
open(path, "w").write("\n".join(head) + "\n" + json.dumps(cfg, indent=2) + "\n")
PY
}
hcfg "http://127.0.0.1:$EMBED_MOCK_PORT/v1"
cp "$CFG" "$OUT/h-jsonc.mock"
for i in $(seq 1 20); do grep -q listening "$OUT/h-embed-mock.log" 2>/dev/null && break; sleep 0.25; done

export MC_E2E_MAIN_PROVIDER=opencode-go-40k
export MC_HISTORIAN_THRESHOLD=65

# --- session A: record the four facts, one user message (and process) each,
# so every fact has its own message ordinal
export OPENCODE_SESSION="mc-ci-h-a-$(date +%s)"
FACTS=("$F_ARCH" "$F_RULE" "$F_FILE" "$F_TODO")
ASID=""
for i in 0 1 2 3; do
  run "h-f$((i + 1))" "Fact $((i + 1)) of 4 about this project — remember it, I will ask about it in later sessions: $(printf '%s' "${FACTS[$i]}") Save it as one project memory with the ctx_memory tool (action \"write\", a fitting category, the content exactly as written, including its codeword). Then reply with the single word DONE." $ASID
  [[ -z "$ASID" ]] && ASID="$(session_of "$OUT/h-f1.log")"
  [[ -z "$ASID" ]] && break
done
echo "$ASID" > "$OUT/h-a.sid"
if [[ -n "$ASID" ]]; then
  hdump "$ASID" a1
  if [[ "$(nmem a1)" -lt 4 ]]; then
    echo "[ci-h] facts: only $(nmem a1)/4 fact memories saved; asking once more (model variance)"
    run h-f5 "Some of the four facts are not saved as project memories yet. Use ctx_memory (action \"write\") to save each one that is missing, content exactly as written: (1) $F_ARCH (2) $F_RULE (3) $F_FILE (4) $F_TODO Reply DONE." "$ASID"
    hdump "$ASID" a1b
  fi
  # --- historian passes: file reads on the 40k route (no meter.ts: its words
  # would compete with the file-relation fact in the semantic lane)
  k=2; grown=0; last=0
  for pair in "src/agent/outbox.ts src/agent/nudge.ts" "src/agent/pressure-truncation.ts src/agent/coordinator.ts" \
              "src/agent/worker.ts src/agent/auto-search.ts" "src/agent/session-track.ts src/agent/knowledge-gate.ts" \
              "src/host/remote.ts src/agent/dreamer.ts" "src/agent/context-plane.ts src/agent/transcript.ts" \
              "src/agent/tools.ts src/agent/commands.ts"; do
    set -- $pair
    name="h-a$k"
    run "$name" "Read the file $1 with the read tool (whole file), then read the file $2 with the read tool (whole file), one after the other. Do not call ctx_reduce. Then tell me the name of the first exported function or constant in each. Two short sentences." "$ASID"
    hdump "$ASID" "a$k"
    n="$(ncomp "a$k" "$ASID")"
    [[ "$n" -gt "$last" ]] && grown=$((grown + 1))
    last="$n"
    k=$((k + 1))
    [[ "$grown" -ge 2 ]] && break
  done
  echo "$((k - 1)) $grown" > "$OUT/h-a.reads"
  # one quiet turn so the next pre-step can index + embed the latest compartments
  run h-aw "Reply with the single word: ok." "$ASID"
  hdump "$ASID" aw
  # --- restart: message lane + ctx_expand original text
  # (round 24c) expand the result that CONTAINS the codeword, not the first one:
  # with the compartment lane on, core folds a message hit into its covering
  # compartment and ranks by RRF, so rank 1 is not the assertion here (U16 checks
  # the hit + ordinal, U17 the expanded original text + range)
  run h-aq "Call the ctx_search tool exactly once with the query \"$FILE\". Then call the ctx_expand tool exactly once, with start and end taken from the range of the [message] result whose text contains $FILE. Then reply with the exact original sentence of that fact as it appears in the expanded text, nothing else." "$ASID"
  # --- compartment (semantic) lane with a paraphrase (no codeword)
  run h-as "Call the ctx_search tool exactly once with the query \"where does the quota gauge take its figures from\" and sources [\"message\"]. Then reply with the first result line exactly as the tool printed it." "$ASID"
  hdump "$ASID" as
  # --- degrade: embedding endpoint unreachable for this one run
  hcfg "http://127.0.0.1:9/v1"
  run h-ad "Call the ctx_search tool exactly once with the query \"$RULE\". Then reply with the first result line exactly as the tool printed it." "$ASID"
  hcfg "http://127.0.0.1:$EMBED_MOCK_PORT/v1"
fi

# --- session B: new session, different wording
export OPENCODE_SESSION="mc-ci-h-b-$(date +%s)"
run h-b1 "New session. Answer from what you know about this project (use ctx_search if you need to). Reply with exactly four lines in the form '<n>: <codeword>' and nothing else: 1) Which component did we decide is the only one allowed to write to the ledger? 2) What did I forbid background workers from doing? 3) Where does the quota gauge get its figures from? 4) What is the open todo? If you cannot find the codeword for a question, write '<n>: unknown'."
BSID="$(session_of "$OUT/h-b1.log")"
echo "$BSID" > "$OUT/h-b.sid"
if [[ -n "$BSID" ]]; then
  hdump "$BSID" b1
  run h-b2 "Correction: the open todo about pruning stale historian leases ($TODO) is cancelled. The new open todo is: add a retry budget to the outbox reconciler (codeword $TODO2). Update the project memory with ctx_memory so that only the new todo remains: archive (or update) the old todo memory and save the new one. Then reply DONE." "$BSID"
  hdump "$BSID" b2
fi

# --- session C: new session — current value, search, never-recorded fact
export OPENCODE_SESSION="mc-ci-h-c-$(date +%s)"
run h-c1 "What is the current open todo of this project? Reply with its codeword only (use ctx_search if you need to)."
CSID_H="$(session_of "$OUT/h-c1.log")"
echo "$CSID_H" > "$OUT/h-c.sid"
if [[ -n "$CSID_H" ]]; then
  hdump "$CSID_H" c1
  run h-c2 "Call the ctx_search tool exactly once with the query \"open todo codeword\". Then reply with the codeword of the current open todo only." "$CSID_H"
  run h-c3 "What codeword did I record for this project's deployment region? Only answer with a codeword that was actually recorded for the deployment region; if none was recorded, reply exactly: NOT RECORDED" "$CSID_H"
fi
hdump "$ASID,$BSID,$CSID_H" final

kill "$EMBED_PID" 2>/dev/null; wait "$EMBED_PID" 2>/dev/null
cp "$OUT/h-jsonc.orig" "$CFG"
unset MC_E2E_MAIN_PROVIDER
echo "[ci-h] done; embedding mock requests: $(wc -l < "$OUT/h-embed-requests.jsonl")"
