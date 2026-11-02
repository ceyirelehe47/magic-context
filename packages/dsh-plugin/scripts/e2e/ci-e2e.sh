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

pgrep -f 'dsh/lib/bin.js' > "$OUT/leftover-procs.txt" || true
echo "[ci-e2e] done; leftover dsh processes: $(wc -l < "$OUT/leftover-procs.txt")"
