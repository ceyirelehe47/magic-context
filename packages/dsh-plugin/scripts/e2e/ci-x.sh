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
plans["xr"] = [{"text": "DONE xr"}]
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
kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
echo "[ci-x] done; requests: $(wc -l < "$OUT/x-requests.jsonl")"
