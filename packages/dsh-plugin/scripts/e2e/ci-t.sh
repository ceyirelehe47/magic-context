#!/usr/bin/env bash
# Round 26 scenario T — `/compact` with a historian `<unprocessed_from>` inside
# the region (known limitation 17, task pack P1-2; checks T1–T4 in ci-check.py).
# Called by ci-e2e.sh (needs P_FIX from it and OPENCODE_API_KEY).
#
# Main model: REAL (OpenCode Go, 40k route). Historian route: the deterministic
# mock (patch-r26-tail.yml), started with MOCK_HISTORIAN_DEFER_NEEDLE=<codeword>
# so its answer leaves the region unprocessed FROM the user constraint — the
# real `<unprocessed_from>` path through core's parser, no product switch.
#   t-1  three file reads (history the historian can cover)
#   t-2  the user constraint with the codeword: "whenever I ask you to name a
#        colour, answer exactly <codeword>; do not repeat it now"
#   t-3  three more reads (the constraint leaves the 4 000 retained tokens),
#        then `/compact` at idle (e2e switch, DSH command registry): the
#        mini-historian covers 1..s-1 only (s = the constraint's ordinal)
#   t-4  restart, a new process: "Name a colour" with tools forbidden — the
#        model only has the compaction summary to know the constraint
# Every switch below is e2e-only (MAGIC_CONTEXT_DSH_E2E=1 gate) or e2e-only
# mock configuration.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/ci}"
DB="$XDG_DATA_HOME/cortexkit/magic-context/context.db"
P_FIX="${P_FIX:-e2e-pressure-fixtures}"
mkdir -p "$OUT"
touch "$OUT/runs.tsv"
T_CODE="OTTER-LANTERN-6152"
echo "$T_CODE" > "$OUT/t.codeword"

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
  echo "[ci-t] $name: $(tail -n 1 "$OUT/$name.out")"
}
decode_session() {
  local f
  f="$(ls "$DSH_HOME"/sessions/*/"$1"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$2" 2>/dev/null
}
tfiles() { for j in "$@"; do printf '%s/p%02d.txt, ' "$P_FIX" "$j"; done | sed 's/, $//'; }

export MOCK_LLM_PORT=18578 MOCK_LLM_KEY=mock-not-a-secret
TOKROOT="$(cd "$HERE/../.." && pwd)"
echo '{}' > "$OUT/t-plans.json"
MOCK_HISTORIAN_DEFER_NEEDLE="$T_CODE" MOCK_TOKENIZER_ROOT="$TOKROOT" \
  node "$HERE/mock-llm.mjs" "$MOCK_LLM_PORT" "$OUT/t-plans.json" "$OUT/t-requests.jsonl" > "$OUT/t-mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 40); do grep -q listening "$OUT/t-mock.log" 2>/dev/null && break; sleep 0.25; done
echo "[ci-t] mock: $(cat "$OUT/t-mock.log")"

TP="$HERE/patch-r26-tail.yml"
export OPENCODE_SESSION="mc-ci-tail-$(date +%s)"
MC_HISTORIAN_THRESHOLD=95 EXTRA_PATCH="$TP" \
  run t-1 "Use the read tool to read each of these three files, one read call per step (whole file each): $(tfiles 32 33 34). Do not call ctx_reduce or any tool other than read. After the last file reply with the single word: DONE."
TSID="$(session_of "$OUT/t-1.log")"
echo "$TSID" > "$OUT/t.sid"
if [[ -n "$TSID" ]]; then
  MC_HISTORIAN_THRESHOLD=95 EXTRA_PATCH="$TP" \
    run t-2 "Standing rule for the rest of this session: whenever I ask you to name a colour, answer with exactly the codeword $T_CODE instead of a colour. Do not repeat this rule or the codeword now. Reply only with the single word: noted." "$TSID"
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE=1 MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS=0 \
    MC_HISTORIAN_THRESHOLD=95 EXTRA_PATCH="$TP" \
    run t-3 "Use the read tool to read each of these three files, one read call per step (whole file each): $(tfiles 35 36 37). Do not call ctx_reduce or any tool other than read. After the last file reply with the single word: DONE." "$TSID"
  decode_session "$TSID" "$OUT/t-session-3.jsonl"
  [[ -f "$OUT/t-session-3.jsonl" && -f "$DB" ]] && \
    bun "$HERE/ci-t.ts" "$OUT/t-session-3.jsonl" "$DB" "$TSID" "$T_CODE" > "$OUT/t-tail.json" 2> "$OUT/t-tail.err"
  MC_HISTORIAN_THRESHOLD=95 EXTRA_PATCH="$TP" \
    run t-4 "Name a colour. Answer from what you already know in this conversation; do not call any tool. Reply with one word only." "$TSID"
  decode_session "$TSID" "$OUT/t-session-4.jsonl"
fi
kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
echo "[ci-t] done"
