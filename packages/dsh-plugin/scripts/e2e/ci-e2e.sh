#!/usr/bin/env bash
# Real-model e2e driver for .github/workflows/dsh-ci.yml (job `e2e`).
#
# Preconditions: scripts/e2e/env.sh environment (E2E_ROOT), local DSH installed
# (bootstrap.sh), plugin built + installed into profile "test" + `setup` run,
# OPENCODE_API_KEY in the environment (never echoed: this script has no
# `set -x` and never prints the environment).
#
# Runs (each `run-headless.sh` call is a fresh `dsh` process):
#   selftest-normal   MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1, default worker timeout
#   selftest-timeout  same, MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS=1500
#                     (re-verifies 502d74b94: workerLog must say why it returned null)
#   multi-1..3        one session, three turns = two process restarts; the Magic
#                     tags of the session are dumped after every turn
#   cmp-*             round 17 C: main session on a 40k route pushed past the
#                     65 % execute threshold (historian, compartments, codeword)
#   use-*             round 17 U: ctx_search / ctx_memory / ctx_expand in it
#   child-parent      round 17 S: `subagent` child on a 24k route hits its limit
# Everything lands in $CI_OUT (default $E2E_ROOT/ci); ci-check.py judges it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/ci}"
DB="$XDG_DATA_HOME/cortexkit/magic-context/context.db"
mkdir -p "$OUT"
: > "$OUT/runs.tsv"

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

# run <name> <task> [session-id]   (extra env is inherited from the caller)
run() {
  local name="$1" task="$2" sid="${3:-}" log
  bash "$HERE/run-headless.sh" "$task" ${sid:+"$sid"} > "$OUT/$name.out" 2>&1
  log="$(tail -n 1 "$OUT/$name.out" | sed -n 's/.*log=//p')"
  if [[ -n "$log" && -f "$log" ]]; then cp "$log" "$OUT/$name.log"; else cp "$OUT/$name.out" "$OUT/$name.log"; fi
  printf '%s\t%s\t%s\n' "$name" "$(session_of "$OUT/$name.log")" "$(tail -n 1 "$OUT/$name.out")" >> "$OUT/runs.tsv"
  echo "[ci-e2e] $name: $(tail -n 1 "$OUT/$name.out")"
}

selftest_called() { grep -q '"tool_result".*WORKER_SELFTEST' "$OUT/$1.log"; }

SELFTEST_TASK_NORMAL="Step 1: call the glob tool with pattern '*' and say how many entries. Step 2: call the ctx_worker_selftest tool exactly once (no arguments). Then reply with the selftest tool's full output text verbatim."
SELFTEST_TASK_TIMEOUT="Call the ctx_worker_selftest tool exactly once (no arguments). Then reply with the tool's full output text verbatim."

export RUN_TIMEOUT="${RUN_TIMEOUT:-400}"
export MC_HISTORIAN_THRESHOLD="${MC_HISTORIAN_THRESHOLD:-40}"

# --- worker self-test, normal + 1500 ms timeout (one retry if the model skipped the tool)
for attempt in 1 2; do
  MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1 OPENCODE_SESSION="mc-ci-st1-$(date +%s)" \
    run selftest-normal "$SELFTEST_TASK_NORMAL"
  selftest_called selftest-normal && break
  echo "[ci-e2e] selftest-normal: model did not call ctx_worker_selftest (attempt $attempt)"
done
for attempt in 1 2; do
  MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1 MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS=1500 \
    OPENCODE_SESSION="mc-ci-st2-$(date +%s)" run selftest-timeout "$SELFTEST_TASK_TIMEOUT"
  selftest_called selftest-timeout && break
  echo "[ci-e2e] selftest-timeout: model did not call ctx_worker_selftest (attempt $attempt)"
done

# --- multi-turn + restart §N§ stability (selftest tool NOT registered here)
unset MAGIC_CONTEXT_DSH_WORKER_SELFTEST MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS
export OPENCODE_SESSION="mc-ci-multi-$(date +%s)"
run multi-1 "Read the file src/agent/outbox.ts with the read tool and tell me the name of the first exported function. Answer in one short sentence."
SID="$(session_of "$OUT/multi-1.log")"
echo "$SID" > "$OUT/multi.sid"
[[ -n "$SID" && -f "$DB" ]] && bun "$HERE/ci-db.ts" "$DB" "$SID" > "$OUT/db-multi-1.json"
if [[ -n "$SID" ]]; then
  run multi-2 "Use the glob tool with pattern 'src/agent/*.ts' and tell me how many files matched. One short sentence." "$SID"
  [[ -f "$DB" ]] && bun "$HERE/ci-db.ts" "$DB" "$SID" > "$OUT/db-multi-2.json"
  run multi-3 "Without calling any tool: in one sentence, what were the two things you looked up earlier in this session?" "$SID"
  [[ -f "$DB" ]] && bun "$HERE/ci-db.ts" "$DB" "$SID" > "$OUT/db-multi-3.json"
fi

# --- child sessions of the self-tests: Magic rows + decoded event summary
python3 - "$OUT" <<'PY' > "$OUT/children.txt"
import json, re, sys
out = sys.argv[1]
for name in ("selftest-normal", "selftest-timeout"):
    try:
        text = open(f"{out}/{name}.log", errors="replace").read()
    except FileNotFoundError:
        continue
    m = re.search(r'"childSessionId\\?"\s*:\s*\\?"([0-9a-f-]{36})', text)
    if m:
        print(f"{name}\t{m.group(1)}")
PY
CHILD_IDS="$(cut -f2 "$OUT/children.txt" | paste -sd, -)"
PARENT_IDS="$(awk -F'\t' '$1 ~ /^selftest/ && $2 != "" {print $2}' "$OUT/runs.tsv" | paste -sd, -)"
[[ -n "$CHILD_IDS$PARENT_IDS" && -f "$DB" ]] && bun "$HERE/ci-db.ts" "$DB" "${CHILD_IDS}${CHILD_IDS:+,}${PARENT_IDS}" > "$OUT/db-selftest.json"
while IFS=$'\t' read -r name cid; do
  f="$(ls "$DSH_HOME"/sessions/*/"$cid"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$OUT/child-$name.jsonl" 2>/dev/null
done < "$OUT/children.txt"

# ============================ round 17 scenarios ============================
# decode_session <dsh-session-id> <out-file>: copy the decoded session log.
decode_session() {
  local f
  f="$(ls "$DSH_HOME"/sessions/*/"$1"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$2" 2>/dev/null
}
r17_db() { [[ -f "$DB" ]] && bun "$HERE/ci-r17.ts" "$@"; }
compartments_of() { python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1])); c=d.get("compartments"); print(len(c) if isinstance(c,list) else 0)
except Exception: print(0)' "$1"; }

export MC_E2E_CODEWORD="AMBER-FALCON-7319"
export MC_HISTORIAN_THRESHOLD=65          # the shipped default; never lowered here
export MC_E2E_MAIN_PROVIDER=opencode-go-40k
MAIN_MODEL_KEY="opencode-go-40k/deepseek-v4.1-flash"

# --- C: main session pushed past the 65 % execute threshold (40k window)
export OPENCODE_SESSION="mc-ci-cmp-$(date +%s)"
r17_db snapshot "$DB" > "$OUT/r17-snap-c0.json"
run cmp-01 "Remember this codeword exactly: $MC_E2E_CODEWORD. It is important; I will ask you for it near the end of this session. For now reply with the single word: noted."
CSID="$(session_of "$OUT/cmp-01.log")"
echo "$CSID" > "$OUT/cmp.sid"
if [[ -n "$CSID" ]]; then
  r17_db session "$DB" "$CSID" 65 "$MAIN_MODEL_KEY" > "$OUT/db-cmp-01.json"
  k=2; after=0
  for f in src/agent/outbox.ts src/host/meter.ts src/agent/nudge.ts src/agent/pressure-truncation.ts \
           src/agent/coordinator.ts src/agent/worker.ts src/agent/auto-search.ts src/agent/session-track.ts; do
    name="cmp-$(printf %02d "$k")"
    run "$name" "Read the file $f with the read tool (whole file) and tell me the name of the first exported function or constant in it. One short sentence." "$CSID"
    r17_db session "$DB" "$CSID" 65 "$MAIN_MODEL_KEY" > "$OUT/db-$name.json"
    if [[ "$(compartments_of "$OUT/db-$name.json")" -gt 0 ]]; then after=$((after + 1)); fi
    [[ "$after" -ge 2 ]] && break
    k=$((k + 1))
  done
  echo "$k" > "$OUT/cmp.reads"
  run cmp-q "Without reading any file: what is the codeword I gave you at the very start of this session? If you no longer see it in the conversation, use ctx_search to find it. Reply with the codeword only." "$CSID"
  r17_db session "$DB" "$CSID" 65 "$MAIN_MODEL_KEY" > "$OUT/db-cmp-q.json"
  # --- U: daily use in the compressed session
  run use-search "Call the ctx_search tool with the query \"codeword\" and tell me in one sentence how many results it returned and whether one of them contains the codeword." "$CSID"
  run use-memory "Call the ctx_memory tool once with action \"write\", a fitting category, and the content \"Round 17 e2e: the session codeword is $MC_E2E_CODEWORD\". Then reply DONE." "$CSID"
  run use-expand "Call the ctx_expand tool once with the start and end attributes of the FIRST <compartment> block in your session history. Then reply with one sentence describing what that range contained." "$CSID"
  r17_db session "$DB" "$CSID" 65 "$MAIN_MODEL_KEY" > "$OUT/db-cmp-final.json"
  decode_session "$CSID" "$OUT/cmp-session.jsonl"
fi
r17_db snapshot "$DB" > "$OUT/r17-snap-c1.json"

# --- S: a delegated child session hits its own (24k) context limit
export OPENCODE_SESSION="mc-ci-child-$(date +%s)"
CHILD_TASK="Use the read tool to read these four files one at a time, in this order: src/agent/outbox.ts, src/host/meter.ts, src/agent/nudge.ts, src/agent/pressure-truncation.ts (read each whole file). After reading all four, reply with exactly four lines, one per file: <path>: <name of the first exported function or constant>."
for attempt in 1 2; do
  r17_db snapshot "$DB" > "$OUT/r17-snap-s0.json"
  EXTRA_PATCH="$HERE/patch-r17-child.yml" run child-parent \
    "Use the subagent tool exactly once to delegate the following task to a subagent, wait for its completion notice, then reply with the subagent's four result lines verbatim. Do not read the files yourself. Subagent task: $CHILD_TASK"
  r17_db snapshot "$DB" > "$OUT/r17-snap-s1.json"
  grep -q 'started subagent' "$OUT/child-parent.log" && break
  echo "[ci-e2e] child-parent: model did not call the subagent tool (attempt $attempt)"
done
PSID="$(session_of "$OUT/child-parent.log")"
echo "$PSID" > "$OUT/child-parent.sid"
KID="$(grep -o 'started subagent [0-9a-zA-Z-]*' "$OUT/child-parent.log" | head -n 1 | awk '{print $3}')"
echo "$KID" > "$OUT/child.sid"
if [[ -n "$PSID" ]]; then
  decode_session "$PSID" "$OUT/child-parent-session.jsonl"
  r17_db session "$DB" "$PSID" 65 "$MAIN_MODEL_KEY" > "$OUT/db-child-parent.json"
fi
if [[ -n "$KID" ]]; then
  decode_session "$KID" "$OUT/child-session.jsonl"
  [[ -f "$DB" ]] && bun "$HERE/ci-db.ts" "$DB" "$KID" > "$OUT/db-child.json"
fi
unset MC_E2E_MAIN_PROVIDER

# --- U: doctor after all runs (shared DB opens, no live liveness markers left)
node "$HERE/../../dist/cli.js" doctor --profile test > "$OUT/doctor-after.txt" 2>&1
echo "rc=$?" >> "$OUT/doctor-after.txt"

pgrep -f 'dsh/lib/bin.js' > "$OUT/leftover-procs.txt" || true
echo "[ci-e2e] done; leftover dsh processes: $(wc -l < "$OUT/leftover-procs.txt")"
