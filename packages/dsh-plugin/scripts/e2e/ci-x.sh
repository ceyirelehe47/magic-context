#!/usr/bin/env bash
# Round 23b scenario X — extreme context pressure on a 24k window, driven by
# the DETERMINISTIC mock model (mock-llm.mjs: real BPE count, window ENFORCED
# like a provider, every request logged). E2E ONLY; needs no model key.
# Called by ci-e2e.sh (and runnable alone with the env.sh environment).
#
#   x-1  one `read` of a 57.7 KB Chinese file (capped by DSH at 50 KB ≈ 47k
#        real tokens > the whole 24k window; the DSH meter prices it ≈ 12.5k)
#   x-2  four 5 000-char Chinese reads, one per step (each ≈ 4.7k tokens —
#        together they would overflow; each alone is under the old char floor)
#   x-3  a background historian pass holds the lease (e2e hold, 20 s) while a
#        49 KB English read and another big Chinese read arrive
#   x-4  fourteen ~5 KB English reads (each below the truncation floor) with
#        MC's execute threshold at 95 %: the native 90 % backstop must compact
#        (mini-historian on the mock historian route)
#   x-2r restart right after x-2 (truncations of ACTIVE tags must replay as is)
#   x-5  restart: a new process continues the session (no tool call)
# Checks X1–X8 in ci-check.py read $OUT/x-requests.jsonl, the run logs, the
# decoded session and the ci-x.ts DB dumps.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/ci}"
DB="$XDG_DATA_HOME/cortexkit/magic-context/context.db"
mkdir -p "$OUT"
touch "$OUT/runs.tsv"
export MOCK_LLM_PORT="${MOCK_LLM_PORT:-18577}" MOCK_LLM_KEY=mock-not-a-secret
XF="e2e-x-fixtures"
python3 - "$XF" "$OUT/x-plans.json" <<'PY'
import json, os, sys
d, plans_out = sys.argv[1], sys.argv[2]
os.makedirs(d, exist_ok=True)
ZH = "这是一个用于测试上下文压力的中文段落，包含常见的汉字和标点符号。"
ZH2 = "第二组内容记录了模型读取大文件时的行为，用来检验截断与恢复。"
EN = "harbor lantern meadow granite orchard copper thistle saffron glacier willow ember quartz falcon juniper"
def write(name, marker, lines):
    with open(os.path.join(d, name), "w") as f:
        f.write(marker + "\n" + "\n".join(lines) + "\n" + marker + "\n")
def zh_lines(total, seed, text=ZH):
    out, n, i = [], 0, 0
    while n < total:
        l = f"{seed}{i:03d} " + text * 40
        out.append(l[: min(len(l), total - n)]); n += len(out[-1]) + 1; i += 1
    return out
def read(name): return {"tool": "read", "args": {"file_path": f"{d}/{name}"}}
plans = {}
write("x1-zh.txt", "MOCKSTEP:x1:1", zh_lines(57000, "a"))
plans["x1"] = [read("x1-zh.txt"), {"text": "DONE x1"}]
plans["x2"] = []
for k in range(1, 5):
    write(f"x2-zh{k}.txt", f"MOCKSTEP:x2:{k}", zh_lines(5000, f"b{k}", ZH2 if k % 2 else ZH))
    plans["x2"].append(read(f"x2-zh{k}.txt"))
plans["x2"].append({"text": "DONE x2"})
write("x3-en.txt", "MOCKSTEP:x3:1", [f"{i:04d} " + EN for i in range(450)])
write("x3-zh.txt", "MOCKSTEP:x3:2", zh_lines(30000, "c", ZH2))
plans["x3"] = [read("x3-en.txt"), read("x3-zh.txt"), {"text": "DONE x3"}]
plans["x4"] = []
for k in range(1, 15):
    write(f"x4-en{k:02d}.txt", f"MOCKSTEP:x4:{k}", [f"{k:02d}{i:03d} " + EN for i in range(45)])
    plans["x4"].append(read(f"x4-en{k:02d}.txt"))
plans["x4"].append({"text": "DONE x4"})
plans["x5"] = [{"text": "DONE x5"}]
# round 23c scenario Y (kill -9 during a historian hold)
plans["y1"] = []
for k in range(1, 4):
    write(f"y1-zh{k}.txt", f"MOCKSTEP:y1:{k}", zh_lines(5000, f"y{k}", ZH2 if k % 2 else ZH))
    plans["y1"].append(read(f"y1-zh{k}.txt"))
plans["y1"].append({"text": "DONE y1"})
plans["y2"] = [{"text": "DONE y2"}]
plans["y3"] = [{"text": "DONE y3"}]
for _k in ("y2b", "y2c", "y2d"):
    plans[_k] = [{"text": f"DONE {_k}"}]
plans["xr"] = [{"text": "DONE xr"}]
# round 25 scenario W (P1-3): the worker CHILD is made to force calls to tools
# outside its allowlist; the bash/write args carry their own step marker, so
# each forced call is emitted once (whether or not it runs)
plans["w1"] = [{"tool": "ctx_worker_selftest", "args": {}}, {"text": "DONE w1"}]
plans["wchild"] = [
    {"tool": "bash", "args": {"description": "forced shell (not allowlisted)",
                              "command": "echo FORCED-BASH-RAN > mc-worker-forced-bash.txt; echo MOCKSTEP:wchild:1"}},
    {"tool": "write", "args": {"file_path": "mc-worker-forced-write.txt", "content": "FORCED-WRITE MOCKSTEP:wchild:2"}},
    {"text": "DONE wchild MOCKSTEP:w1:1"},
]
# round 25 scenario S (P1-2): 5 sessions x 4 rounds, 2 long (3 reads/round)
# and 3 short (1 read/round), every run a restart, each round all in parallel
for si in range(1, 6):
    for rj in range(1, 5):
        key = f"s{si}r{rj}"
        plans[key] = []
        for k in range(1, (4 if si <= 2 else 2)):
            write(f"{key}-{k}.txt", f"MOCKSTEP:{key}:{k}", zh_lines(4000, f"s{si}{rj}{k}", ZH2 if (si + k) % 2 else ZH))
            plans[key].append(read(f"{key}-{k}.txt"))
        plans[key].append({"text": f"DONE {key}"})
# round 25b: five one-line warm-up turns per S session before the stress rounds
# (real user turns, so core's 5-user-turn protected tail is passed and the
# historian has eligible history while the stress rounds run in parallel)
for wk in range(1, 6):
    plans[f"sw{wk}"] = [{"text": f"DONE sw{wk}"}]
json.dump(plans, open(plans_out, "w"), ensure_ascii=False)
PY
TOKROOT="$(ls -d "$REPO"/node_modules/.bun/ai-tokenizer@*/node_modules | head -n 1)"
: > "$OUT/x-requests.jsonl"
MOCK_TOKENIZER_ROOT="$TOKROOT" node "$HERE/mock-llm.mjs" "$MOCK_LLM_PORT" "$OUT/x-plans.json" "$OUT/x-requests.jsonl" > "$OUT/x-mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 40); do grep -q listening "$OUT/x-mock.log" 2>/dev/null && break; sleep 0.25; done
echo "[ci-x] mock: $(cat "$OUT/x-mock.log")"

session_of() { python3 -c 'import json,sys
for l in open(sys.argv[1], errors="replace"):
  try: o=json.loads(l)
  except Exception: continue
  if o.get("type")=="session": print(o.get("sessionId","")); break' "$1"; }
xrun() {
  local name="$1" task="$2" sid="${3:-}" log
  EXTRA_PATCH="$HERE/model-mock.yml" MC_E2E_MAIN_PROVIDER=mock-24k bash "$HERE/run-headless.sh" "$task" ${sid:+"$sid"} > "$OUT/$name.out" 2>&1
  log="$(tail -n 1 "$OUT/$name.out" | sed -n 's/.*log=//p')"
  if [[ -n "$log" && -f "$log" ]]; then cp "$log" "$OUT/$name.log"; else cp "$OUT/$name.out" "$OUT/$name.log"; fi
  printf '%s\t%s\t%s\n' "$name" "$(session_of "$OUT/$name.log")" "$(tail -n 1 "$OUT/$name.out")" >> "$OUT/runs.tsv"
  echo "[ci-x] $name: $(tail -n 1 "$OUT/$name.out")"
}
xdb() { [[ -f "$DB" ]] && bun "$HERE/ci-x.ts" "$DB" "$1" > "$OUT/db-$2.json" 2>/dev/null; }

export OPENCODE_SESSION="mc-ci-x-$(date +%s)"
echo "$OPENCODE_SESSION" > "$OUT/x.mock-session"
MC_HISTORIAN_THRESHOLD=65 xrun x-1 "Read the file as planned. [[MOCK:x1]]"
XSID="$(session_of "$OUT/x-1.log")"
echo "$XSID" > "$OUT/x.sid"
if [[ -n "$XSID" ]]; then
  xdb "$XSID" x-1
  MC_HISTORIAN_THRESHOLD=65 xrun x-2 "Read the four files as planned. [[MOCK:x2]]" "$XSID"
  xdb "$XSID" x-2
  # restart right after the dense reads, while their truncations are live
  MC_HISTORIAN_THRESHOLD=95 xrun x-2r "Reply when done. [[MOCK:xr]]" "$XSID"
  xdb "$XSID" x-2r
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_HISTORIAN_HOLD_MS=20000 MC_HISTORIAN_THRESHOLD=30 \
    xrun x-3 "Read the two files as planned. [[MOCK:x3]]" "$XSID"
  xdb "$XSID" x-3
  MC_HISTORIAN_THRESHOLD=95 xrun x-4 "Read the fourteen files as planned. [[MOCK:x4]]" "$XSID"
  xdb "$XSID" x-4
  MC_HISTORIAN_THRESHOLD=95 xrun x-5 "Reply when done. [[MOCK:x5]]" "$XSID"
  xdb "$XSID" x-5
  f="$(ls "$DSH_HOME"/sessions/*/"$XSID"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$OUT/x-session.jsonl" 2>/dev/null
  # X6 compares sha256 of the originals; the redact step (run before check)
  # rewrites $HOME to "~" inside the tool results, so hash them NOW (round 23c).
  [[ -s "$OUT/x-session.jsonl" ]] && python3 "$HERE/ci-check.py" xsha "$OUT" > "$OUT/x-session-sha.json" 2>/dev/null
fi

# --- Scenario Y (round 23c, P0-2): kill -9 the DSH process while a background
# historian pass holds the compartment lease (e2e hold, 90 s), then continue the
# SAME session in new processes. Checks Y1–Y6 (ci-check.py check_y).
#   y-1  three dense reads; historian fires (threshold 30) and holds; SIGKILL
#        from outside (kill -9 on the node pid) once the hold line is logged
#   y-2  restart, one turn (status dump: busy probe + lease rows per step)
#   y-2b…y-2d  three more restarted one-line turns (real user turns, round 24c)
#   y-3  restart again (rerun must not duplicate anything)
YMARK="YKILL$$"
export OPENCODE_SESSION="mc-ci-y-$(date +%s)"
LOGDIR="$E2E_ROOT/logs"
before_logs="$(ls "$LOGDIR" 2>/dev/null | grep -c '^run-' || true)"
( MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_HISTORIAN_HOLD_MS=90000 MC_HISTORIAN_THRESHOLD=30 RUN_TIMEOUT=200 \
    xrun y-1 "Read the three files as planned. [[MOCK:y1]] $YMARK" ) &
YBG=$!
YLOG="$LOGDIR/run-$((before_logs + 1)).log"
held=""
for i in $(seq 1 240); do
  grep -q "historian holding the compartment lease" "$YLOG" 2>/dev/null && { held=1; break; }
  kill -0 "$YBG" 2>/dev/null || break
  sleep 0.25
done
NODEPID=""
for p in $(pgrep -f "$YMARK" 2>/dev/null); do
  [[ "$(ps -o comm= -p "$p" 2>/dev/null)" == node ]] && NODEPID="$p"
done
if [[ -n "$held" && -n "$NODEPID" ]]; then
  kill -9 "$NODEPID"
  printf '{"held": true, "killedPid": %s, "at": %s}\n' "$NODEPID" "$(date +%s%3N)" > "$OUT/y-kill.json"
else
  printf '{"held": %s, "killedPid": null}\n' "${held:-false}" > "$OUT/y-kill.json"
fi
wait "$YBG" 2>/dev/null
echo "[ci-x] y kill: $(cat "$OUT/y-kill.json")"
YSID="$(session_of "$OUT/y-1.log")"
echo "$YSID" > "$OUT/y.sid"
if [[ -n "$YSID" ]]; then
  xdb "$YSID" y-1k
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_STATUS_DUMP="$OUT/y-2-status.jsonl" MC_HISTORIAN_THRESHOLD=30 \
    xrun y-2 "Reply when done. [[MOCK:y2]]" "$YSID"
  xdb "$YSID" y-2
  # Round 24c: three more real user turns (each a restart) so the interrupted
  # y-1 turn leaves the 5-user-turn protected tail (core
  # PROTECTED_TAIL_USER_TURNS) and the y-3 pass has real history to publish.
  # Before a529b7846 Magic's injected m0 baseline counted as a user turn and Y3
  # was satisfied by a compartment of that block alone ([1,1] in 41672370986).
  for yk in y2b y2c y2d; do MC_HISTORIAN_THRESHOLD=30 xrun "y-${yk#y}" "Reply when done. [[MOCK:$yk]]" "$YSID"; done
  MC_HISTORIAN_THRESHOLD=30 xrun y-3 "Reply when done. [[MOCK:y3]]" "$YSID"
  xdb "$YSID" y-3
  [[ -n "$XSID" ]] && xdb "$XSID" x-after-y
  f="$(ls "$DSH_HOME"/sessions/*/"$YSID"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$OUT/y-session.jsonl" 2>/dev/null
fi

# --- Scenario W (round 25, P1-3): the worker self-test on the mock model; the
# worker's CHILD (allowlist read/grep/glob) is made to call bash and write
# anyway. Checks W1–W4: the forced calls reach the executor, are refused, have
# no effect on disk, and the parent's own tools are untouched.
find "$REPO" "$E2E_ROOT" -maxdepth 7 -name 'mc-worker-forced-*' -delete 2>/dev/null
export OPENCODE_SESSION="mc-ci-w-$(date +%s)"
MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1 MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_WORKER_PROMPT_SUFFIX='[[MOCK:wchild]]' \
  MC_HISTORIAN_THRESHOLD=95 xrun w-1 "Run the worker self-test as planned. [[MOCK:w1]]"
find "$REPO" "$E2E_ROOT" -maxdepth 7 -name 'mc-worker-forced-*' > "$OUT/w-forced-files.txt" 2>/dev/null
WCID="$(python3 -c 'import re,sys
t=open(sys.argv[1],errors="replace").read()
m=re.search(r"\"childSessionId\\?\"\s*:\s*\\?\"([0-9a-f-]{36})",t)
print(m.group(1) if m else "")' "$OUT/w-1.log" 2>/dev/null)"
echo "$WCID" > "$OUT/w-child.sid"
if [[ -n "$WCID" ]]; then
  f="$(ls "$DSH_HOME"/sessions/*/"$WCID"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$OUT/w-child.jsonl" 2>/dev/null
fi
echo "[ci-x] w: child=$WCID forced files: $(wc -l < "$OUT/w-forced-files.txt")"

# --- Scenario S (round 25, P1-2): short multi-session stress on the mock model.
# 5 sessions x 4 rounds sharing the DB; every run is a fresh process (restart);
# each round runs the 5 sessions IN PARALLEL. Per run: rc, wall time and max
# RSS (GNU time when present); per round: ci-s.ts dump (duplicates, overlaps,
# leases, open outbox rows, file sizes). Checks S1–S6.
SMARK="SSTRESS$$"
declare -A SSID
TIMEBIN="$(command -v /usr/bin/time || true)"
srun() { # srun <name> <plan> <session-env> [sid]
  local name="$1" plan="$2" sess="$3" sid="${4:-}"
  if [[ -n "$TIMEBIN" ]]; then
    RUN_LOG="$E2E_ROOT/logs/run-$name.log" OPENCODE_SESSION="$sess" MC_HISTORIAN_THRESHOLD=35 "$TIMEBIN" -f '%M %e' -o "$OUT/$name.time" \
      bash -c "$(declare -f xrun session_of); HERE='$HERE' OUT='$OUT'; xrun '$name' 'Read the files as planned. [[MOCK:$plan]] $SMARK' '$sid'"
  else
    RUN_LOG="$E2E_ROOT/logs/run-$name.log" OPENCODE_SESSION="$sess" MC_HISTORIAN_THRESHOLD=35 xrun "$name" "Read the files as planned. [[MOCK:$plan]] $SMARK" "$sid"
  fi
}
# Round 25b: e2e 41693402758 ST5 FAIL — every historian pass of the five S
# sessions was 'nothing to compact (eligibleEnd=1 <= offset=1)': four runs are
# four real user turns, all inside core's 5-user-turn protected tail
# (PROTECTED_TAIL_USER_TURNS; injected messages stopped counting in a529b7846,
# cf. scenario Y d8daa0264). Five warm-up rounds (one-line turns, each a
# restart, the five sessions in parallel) come first, so from stress round 1 on
# the historian has real eligible history while the sessions run concurrently.
# ST5's assertion is unchanged; ST1 also requires the warm-up runs.
for wk in 1 2 3 4 5; do
  SPIDS=()
  for si in 1 2 3 4 5; do
    RUN_LOG="$E2E_ROOT/logs/run-sw-$si-$wk.log" OPENCODE_SESSION="mc-ci-s$si-$$" MC_HISTORIAN_THRESHOLD=35 \
      xrun "sw-$si-$wk" "Reply when done. [[MOCK:sw$wk]] $SMARK" "${SSID[$si]:-}" &
    SPIDS+=($!)
  done
  wait "${SPIDS[@]}"
  for si in 1 2 3 4 5; do
    [[ -z "${SSID[$si]:-}" ]] && SSID[$si]="$(session_of "$OUT/sw-$si-$wk.log")"
  done
done
for rj in 1 2 3 4; do
  SPIDS=()
  for si in 1 2 3 4 5; do
    srun "s-$si-$rj" "s${si}r${rj}" "mc-ci-s$si-$$" "${SSID[$si]:-}" &
    SPIDS+=($!)
  done
  wait "${SPIDS[@]}"  # NOT a bare wait: the mock model is a background child too
  for si in 1 2 3 4 5; do
    [[ -z "${SSID[$si]:-}" ]] && SSID[$si]="$(session_of "$OUT/s-$si-$rj.log")"
  done
  SIDS="$(for si in 1 2 3 4 5; do printf '%s,' "${SSID[$si]:-}"; done)"
  printf '%s\n' "${SIDS%,}" > "$OUT/s.sids"
  [[ -f "$DB" ]] && bun "$HERE/ci-s.ts" "$DB" "${SIDS%,}" > "$OUT/s-db-r$rj.json" 2>/dev/null
done
sleep 2
pgrep -af "$SMARK" | grep -v pgrep > "$OUT/s-leftover-procs.txt" 2>/dev/null || true
echo "[ci-x] s: sessions ${SIDS%,}; leftover: $(wc -l < "$OUT/s-leftover-procs.txt")"

kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
echo "[ci-x] done; requests: $(wc -l < "$OUT/x-requests.jsonl")"
