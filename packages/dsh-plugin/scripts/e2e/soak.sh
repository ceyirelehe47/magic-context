#!/usr/bin/env bash
# Round 26 (P1-4) — low-cost long soak of the DSH adapter (dsh-soak.yml).
#
# One SEGMENT: restores the state of the previous segment (shared Magic DB,
# DSH sessions, CSV, counters), then loops real `dsh` headless processes until
# SOAK_MINUTES have passed:
#   - mock turns (deterministic mock-llm.mjs, 24k window enforced, valid mock
#     historian): three rotating sessions, each turn reads three ~4 KB files
#     (pressure → historian passes, compactions); a session is retired after
#     SOAK_SESSION_TURNS turns and a fresh one starts (bounded live set, an
#     ever-growing DB like real use);
#   - every SOAK_REAL_EVERY_MIN minutes one REAL-model turn (OpenCode Go 24k
#     route, OPENCODE_API_KEY) in its own session — sampling the key path.
# After every run one CSV row: rc, wall time, max RSS (GNU time %M), DB / WAL
# bytes, open-lock file left, leftover dsh processes, live leases, historian
# in-progress flags, unsettled outbox rows, pending ops, row counts, mock
# requests over the window. soak-check.py judges the trends.
#
# Env: SOAK_MINUTES (default 10), SOAK_SEGMENT (1), SOAK_STATE (dir; restored
# from / saved to), SOAK_REAL_EVERY_MIN (30; 0 = never), SOAK_SESSION_TURNS (40).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
STATE="${SOAK_STATE:-$E2E_ROOT/soak-state}"
SEG="${SOAK_SEGMENT:-1}"
MIN="${SOAK_MINUTES:-10}"
REAL_EVERY="${SOAK_REAL_EVERY_MIN:-30}"
TURNS="${SOAK_SESSION_TURNS:-40}"
OUT="$E2E_ROOT/soak"
DB="$XDG_DATA_HOME/cortexkit/magic-context/context.db"
mkdir -p "$STATE" "$OUT"
CSV="$STATE/soak.csv"
CTR="$STATE/counters.json"

# --- restore the previous segment
if [[ -f "$STATE/state.tgz" ]]; then
  tar -xzf "$STATE/state.tgz" -C "$E2E_ROOT"
  echo "[soak] restored state of segment $((SEG - 1)) ($(du -sh "$STATE/state.tgz" | cut -f1))"
fi
[[ -f "$CSV" ]] || echo "ts,segment,iter,kind,slot,rc,elapsed_s,rss_kb,db_bytes,wal_bytes,open_lock,leftover,live_leases,in_progress,outbox_open,pending_ops,sessions,compartments,tags,fts_rows,historian_runs,historian_failed,over_window" > "$CSV"
[[ -f "$CTR" ]] || echo '{"iter":0,"slots":["","",""],"turns":[0,0,0],"realSid":"","lastReal":0}' > "$CTR"
ctr() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, d))' "$CTR" "$1"; }
ctr_set() { python3 - "$CTR" "$1" <<'PY'
import json, sys
p, expr = sys.argv[1], sys.argv[2]
d = json.load(open(p)); exec(expr, {}, d); json.dump(d, open(p, "w"))
PY
}

# --- fixtures + mock model
FX="$OUT/fixtures"
python3 - "$FX" "$OUT/plans.json" <<'PY'
import json, os, sys
d, plans_out = sys.argv[1], sys.argv[2]
os.makedirs(d, exist_ok=True)
EN = "harbor lantern meadow granite orchard copper thistle saffron glacier willow ember quartz falcon juniper"
ZH = "这是一个用于长时间稳定性测试的中文段落，包含常见的汉字和标点符号。"
plans = {}
for p in range(10):
    steps = []
    for k in range(1, 4):
        name = f"r{p}-{k}.txt"
        body = [f"{p}{k}{i:03d} " + (EN if (p + k) % 2 else ZH * 2) for i in range(32)]
        with open(os.path.join(d, name), "w") as f:
            f.write(f"MOCKSTEP:r{p}:{k}\n" + "\n".join(body) + f"\nMOCKSTEP:r{p}:{k}\n")
        steps.append({"tool": "read", "args": {"file_path": f"{d}/{name}"}})
    steps.append({"text": f"DONE r{p}"})
    plans[f"r{p}"] = steps
json.dump(plans, open(plans_out, "w"))
PY
export MOCK_LLM_PORT=18590 MOCK_LLM_KEY=mock-not-a-secret
MOCK_TOKENIZER_ROOT="$(cd "$HERE/../.." && pwd)" node "$HERE/mock-llm.mjs" "$MOCK_LLM_PORT" "$OUT/plans.json" "$STATE/requests.jsonl" > "$OUT/mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 40); do grep -q listening "$OUT/mock.log" 2>/dev/null && break; sleep 0.25; done

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
size() { [[ -f "$1" ]] && stat -c %s "$1" || echo 0; }
# max RSS (KB) of the whole process tree of one run (getrusage RUSAGE_CHILDREN,
# the same figure GNU time %M reports; works where /usr/bin/time is missing)
cat > "$OUT/maxrss.py" <<'PY'
import resource, subprocess, sys
rc = subprocess.call(sys.argv[2:])
open(sys.argv[1], "w").write(str(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss) + "\n")
sys.exit(rc)
PY

# one_run <kind> <slot> <task> <sid> -> sets RUN_SID; appends the CSV row
one_run() {
  local kind="$1" slot="$2" task="$3" sid="$4" log="$OUT/run.log" t0 t1 rc rss
  t0=$(date +%s.%N)
  if [[ "$kind" == "mock" ]]; then
    python3 "$OUT/maxrss.py" "$OUT/rss.txt" env EXTRA_PATCH="$HERE/model-mock.yml" MC_E2E_MAIN_PROVIDER=mock-24k \
      OPENCODE_SESSION="soak-$SEG-$(ctr iter)" RUN_LOG="$log" RUN_TIMEOUT=300 \
      bash "$HERE/run-headless.sh" "$task" ${sid:+"$sid"} > "$OUT/run.out" 2>&1
  else
    python3 "$OUT/maxrss.py" "$OUT/rss.txt" env OPENCODE_SESSION="soak-real-$SEG-$(ctr iter)" RUN_LOG="$log" RUN_TIMEOUT=300 \
      bash "$HERE/run-headless.sh" "$task" ${sid:+"$sid"} > "$OUT/run.out" 2>&1
  fi
  t1=$(date +%s.%N)
  rc="$(tail -n 1 "$OUT/run.out" | sed -n 's/^rc=\([0-9]*\).*/\1/p')"
  rss="$(tail -n 1 "$OUT/rss.txt" 2>/dev/null | tr -dc 0-9)"
  RUN_SID="$(session_of "$log")"
  if [[ "${rc:-1}" != "0" ]]; then
    FAILS=$((FAILS + 1)); cp "$log" "$STATE/fail-$SEG-$(ctr iter)-$kind.log" 2>/dev/null || cp "$OUT/run.out" "$STATE/fail-$SEG-$(ctr iter)-$kind.log"
  else
    FAILS=0
  fi
  local probe left over
  probe="$(bun "$HERE/soak-probe.ts" "$DB" 2>/dev/null || echo '{}')"
  left="$(pgrep -fc 'dsh/lib/bin.js' 2>/dev/null || true)"
  over="$(grep -c context_length_exceeded "$STATE/requests.jsonl" 2>/dev/null || true)"
  python3 - "$CSV" "$probe" <<PY
import json, sys, time
p = json.loads(sys.argv[2] or "{}") if sys.argv[2].strip() else {}
g = lambda k: p.get(k, -1)
row = [int(time.time()), $SEG, $(ctr iter), "$kind", $slot, "${rc:-1}", round($t1 - $t0, 2), "${rss:-0}",
       $(size "$DB"), $(size "$DB-wal"), int($( [[ -f "$DB.dsh-open.lock" ]] && echo 1 || echo 0 )), int("${left:-0}" or 0),
       g("liveLeases"), g("inProgress"), g("outboxOpen"), g("pendingOps"), g("sessions"), g("compartments"), g("tags"),
       g("ftsRows"), g("historianRuns"), g("historianFailed"), int("${over:-0}" or 0)]
open(sys.argv[1], "a").write(",".join(str(x) for x in row) + "\n")
PY
}

END=$(( $(date +%s) + MIN * 60 ))
FAILS=0
while (( $(date +%s) < END )); do
  # circuit breaker: 5 consecutive failed runs end the segment (the CSV says why)
  if (( FAILS >= 5 )); then echo "[soak] 5 consecutive failed runs — segment stopped"; echo "breaker,$SEG,$(ctr iter)" >> "$STATE/breaker.txt"; break; fi
  ctr_set "iter += 1"
  it=$(ctr iter)
  now=$(date +%s)
  if [[ -n "${OPENCODE_API_KEY:-}" && "$REAL_EVERY" != "0" ]] && (( now - $(ctr lastReal) >= REAL_EVERY * 60 )); then
    one_run real -1 "Reply with the single word: ok." "$(ctr realSid)"
    [[ -n "$RUN_SID" ]] && ctr_set "realSid = '$RUN_SID'"
    ctr_set "lastReal = $now"
    continue
  fi
  slot=$(( it % 3 ))
  if (( $(ctr "turns[$slot]") >= TURNS )); then ctr_set "slots[$slot] = ''; turns[$slot] = 0"; fi
  one_run mock "$slot" "Read the files as planned. [[MOCK:r$(( it % 10 ))]]" "$(ctr "slots[$slot]")"
  [[ -n "$RUN_SID" ]] && ctr_set "slots[$slot] = '$RUN_SID'; turns[$slot] += 1"
done
kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null

# --- save the state for the next segment (DB + DSH sessions; the CSV and
# counters live in $STATE already)
rm -f "$STATE/state.tgz"
tar -czf "$STATE/state.tgz" -C "$E2E_ROOT" xdg/data home/sessions home/storages 2>/dev/null
echo "[soak] segment $SEG done: $(( $(wc -l < "$CSV") - 1 )) rows total; state $(du -sh "$STATE/state.tgz" | cut -f1)"
