#!/usr/bin/env bash
# Round 26 scenario E — exact-identifier ranking: bag-of-words mock vs a REAL
# embedding model on the SAME history (task pack P1-3, limitation 19). Runs
# after ci-h.sh on scenario H's session A (real compartments written by the
# real historian). The main model is the deterministic mock (no key): one turn
# calls ctx_search once per codeword (exact identifier) and once with a
# paraphrase. Embeddings:
#   e-bow-*   embed-mock.mjs (bag of words, the e2e default since round 24b)
#   e-real-*  embed-real.mjs (Xenova/all-MiniLM-L6-v2 = core's default local
#             model, via @huggingface/transformers) behind the same
#             openai-compatible endpoint shape — only the vectors differ.
# Each backend gets two quiet warm-up turns first (index + re-embed under the
# new model identity), then the query turn. Check E1–E2 in ci-check.py.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/ci}"
mkdir -p "$OUT"
touch "$OUT/runs.tsv"
ASID="$(cat "$OUT/h-a.sid" 2>/dev/null)"
[[ -z "$ASID" ]] && { echo "[ci-e] no scenario H session A; skipped"; exit 0; }
CFG="$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc"
cp "$CFG" "$OUT/e-jsonc.orig"
CODES=(ARCH-KESTREL-4127 RULE-MARMOT-5830 FILE-HERON-2261 TODO-BISON-9074)
PARA="where does the quota gauge take its figures from"
python3 - "$OUT/e-plans.json" "$PARA" "${CODES[@]}" <<'PY'
import json, sys
out, para, codes = sys.argv[1], sys.argv[2], sys.argv[3:]
steps = [{"tool": "ctx_search", "once": True, "args": {"query": c}} for c in codes]
steps.append({"tool": "ctx_search", "once": True, "args": {"query": para, "sources": ["message"]}})
plans = {}
for b in ("bow", "real"):
    plans[f"e{b}w1"] = [{"text": f"DONE e{b}w1"}]
    plans[f"e{b}w2"] = [{"text": f"DONE e{b}w2"}]
    plans[f"e{b}q"] = [dict(st, args=dict(st["args"])) for st in steps] + [{"text": f"DONE e{b}q"}]
json.dump(plans, open(out, "w"))
PY
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
erun() { # erun <name> <plan>
  local name="$1" plan="$2" log
  EXTRA_PATCH="$HERE/patch-r26-embed.yml" \
    bash "$HERE/run-headless.sh" "Reply when done. [[MOCK:$plan]]" "$ASID" > "$OUT/$name.out" 2>&1
  log="$(tail -n 1 "$OUT/$name.out" | sed -n 's/.*log=//p')"
  if [[ -n "$log" && -f "$log" ]]; then cp "$log" "$OUT/$name.log"; else cp "$OUT/$name.out" "$OUT/$name.log"; fi
  printf '%s\t%s\t%s\n' "$name" "$(session_of "$OUT/$name.log")" "$(tail -n 1 "$OUT/$name.out")" >> "$OUT/runs.tsv"
  echo "[ci-e] $name: $(tail -n 1 "$OUT/$name.out")"
}
ecfg() { python3 - "$CFG" "$1" "$2" <<'PY'
import json, sys
path, endpoint, model = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
head = [l for l in lines if l.lstrip().startswith("//")]
cfg = json.loads("\n".join(l for l in lines if not l.lstrip().startswith("//")))
cfg["embedding"] = {"provider": "openai-compatible", "endpoint": endpoint, "model": model}
open(path, "w").write("\n".join(head) + "\n" + json.dumps(cfg, indent=2) + "\n")
PY
}
export MOCK_LLM_PORT=18581 MOCK_LLM_KEY=mock-not-a-secret MC_HISTORIAN_THRESHOLD=95
TOKROOT="$(cd "$HERE/../.." && pwd)"
MOCK_TOKENIZER_ROOT="$TOKROOT" node "$HERE/mock-llm.mjs" "$MOCK_LLM_PORT" "$OUT/e-plans.json" "$OUT/e-requests.jsonl" > "$OUT/e-mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 40); do grep -q listening "$OUT/e-mock.log" 2>/dev/null && break; sleep 0.25; done

# --- bag of words
node "$HERE/embed-mock.mjs" 18582 "$OUT/e-bow-requests.jsonl" > "$OUT/e-bow-embed.log" 2>&1 &
EP=$!
for i in $(seq 1 20); do grep -q listening "$OUT/e-bow-embed.log" 2>/dev/null && break; sleep 0.25; done
ecfg "http://127.0.0.1:18582/v1" "bow-mock-256"
erun e-bow-w1 eboww1; erun e-bow-w2 eboww2; erun e-bow-q ebowq
kill "$EP" 2>/dev/null; wait "$EP" 2>/dev/null

# --- real embedding model (downloaded from the Hugging Face hub on first use)
EMBED_REAL_CACHE="$E2E_ROOT/hf-cache" node "$HERE/embed-real.mjs" 18583 "$OUT/e-real-requests.jsonl" "$(cd "$HERE/../../../plugin" && pwd)" \
  > "$OUT/e-real-embed.log" 2>&1 &
EP=$!
for i in $(seq 1 600); do grep -q "listening\|Error" "$OUT/e-real-embed.log" 2>/dev/null && break; sleep 0.5; done
echo "[ci-e] real embedder: $(tail -n 1 "$OUT/e-real-embed.log")"
if grep -q listening "$OUT/e-real-embed.log"; then
  ecfg "http://127.0.0.1:18583/v1" "minilm-real-384"
  erun e-real-w1 erealw1; erun e-real-w2 erealw2; erun e-real-q erealq
fi
kill "$EP" 2>/dev/null; wait "$EP" 2>/dev/null
kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null
cp "$OUT/e-jsonc.orig" "$CFG"
printf '%s\n' "${CODES[@]}" > "$OUT/e.codes"
echo "$PARA" > "$OUT/e.para"
echo "[ci-e] done; bow requests $(wc -l < "$OUT/e-bow-requests.jsonl" 2>/dev/null), real requests $(wc -l < "$OUT/e-real-requests.jsonl" 2>/dev/null)"
