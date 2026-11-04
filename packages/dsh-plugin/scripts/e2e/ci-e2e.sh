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
#   child-parent      round 17/18 S: `subagent` child on a 24k route reads eight
#                     <8 KB files until compaction-basic must summarize
#   pnew-* / pold-*   round 19 P: native pressure compaction vs MC 65 % on a
#                     100k main route (shipped policy vs explicit DSH defaults)
#   t-*               round 26 T: /compact with <unprocessed_from> (ci-t.sh)
#   m-*               round 26 M: legacy migration via the built CLI (ci-m.sh)
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
# Round 19: e2e-only fault injection — the FIRST historian output of scenario C
# is replaced by truncated XML (exactly once, O_EXCL marker) so the repair
# retry (f8c663fee) runs in real DSH; check C10. Never set outside this script.
export MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE="$(cd "$OUT" && pwd)/historian-corrupt.marker"
rm -f "$MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE"
export OPENCODE_SESSION="mc-ci-cmp-$(date +%s)"
r17_db snapshot "$DB" > "$OUT/r17-snap-c0.json"
run cmp-01 "Remember this codeword exactly: $MC_E2E_CODEWORD. It is important; I will ask you for it near the end of this session. For now reply with the single word: noted."
CSID="$(session_of "$OUT/cmp-01.log")"
echo "$CSID" > "$OUT/cmp.sid"
if [[ -n "$CSID" ]]; then
  r17_db session "$DB" "$CSID" 65 "$MAIN_MODEL_KEY" > "$OUT/db-cmp-01.json"
  k=2; after=0
  # Round 18: two files per turn (~12 % of the 40k window each). With the
  # cross-process fold fixed, one file per turn let core's proactive trigger
  # (threshold-2 = 63 %) compress the session before it ever passed 65 %
  # (run 41550425336: max 61.7 %), so C1 could not show real pressure. A pair
  # takes the context from ~50 % past 65 % inside one turn, before the
  # background historian's fold can land (next process).
  # Round 19 run 41591017319: the model ctx_reduce'd its own reads every turn
  # and the context peaked at 61 % (C1/C2 FAIL, a model-side variance — runs
  # 41586948399/41589483637 reached 81 %/75 %). The read turns now ask it not
  # to drop anything, and two more pairs are available.
  for pair in "src/agent/outbox.ts src/host/meter.ts" "src/agent/nudge.ts src/agent/pressure-truncation.ts" \
              "src/agent/coordinator.ts src/agent/worker.ts" "src/agent/auto-search.ts src/agent/session-track.ts" \
              "src/agent/knowledge-gate.ts src/host/remote.ts" "src/agent/dreamer.ts src/agent/context-plane.ts"; do
    set -- $pair
    name="cmp-$(printf %02d "$k")"
    run "$name" "Read the file $1 with the read tool (whole file), then read the file $2 with the read tool (whole file), one after the other. Do not call ctx_reduce. Then tell me the name of the first exported function or constant in each. Two short sentences." "$CSID"
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
unset MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE

# --- S: a delegated child session hits its own (24k) context limit
export OPENCODE_SESSION="mc-ci-child-$(date +%s)"
# Round 18: eight generated files of ~6.9k chars each — under the tool-result
# pruner's 8192-char threshold, so the stock pruner cannot shadow them (round
# 17's four big source files were only pruned, never summarized). ~1.7k tokens
# each on top of the child's ~9.3k base crosses the 16 800-token (0.7 × 24k)
# compaction threshold around the fifth read, so compaction-basic has to run
# its summarizer. Each file ends with a CHECKSUM line only reachable by reading
# the whole file.
FIX_DIR="e2e-child-fixtures"
python3 - "$FIX_DIR" "$OUT/child-checksums.txt" <<'PY'
import hashlib, os, sys
d, out = sys.argv[1], sys.argv[2]
os.makedirs(d, exist_ok=True)
words = ("harbor lantern meadow granite orchard copper thistle saffron glacier willow "
         "ember quartz falcon juniper marble cobalt tundra velvet cedar prism").split()
sums = []
for k in range(1, 9):
    h = hashlib.sha256(f"r18-child-{k}".encode()).hexdigest()
    lines = [f"# round 18 child fixture {k}/8 (generated by ci-e2e.sh)"]
    i = 0
    while sum(len(l) + 1 for l in lines) < 6800:
        seed = hashlib.sha256(f"{k}:{i}".encode()).digest()
        lines.append(f"{i:03d} " + " ".join(words[b % len(words)] for b in seed[:10]) + ".")
        i += 1
    cs = f"R18-{k}-{h[:6].upper()}"
    lines.append(f"CHECKSUM: {cs}")
    text = "\n".join(lines) + "\n"
    assert len(text) < 8192, len(text)
    open(os.path.join(d, f"part{k}.txt"), "w").write(text)
    sums.append(f"{d}/part{k}.txt\t{cs}\t{len(text)}")
open(out, "w").write("\n".join(sums) + "\n")
PY
CHILD_FILES="$(for k in 1 2 3 4 5 6 7 8; do printf '%s/part%s.txt, ' "$FIX_DIR" "$k"; done | sed 's/, $//')"
CHILD_TASK="Use the read tool to read these eight files one at a time, in this order: $CHILD_FILES (read each whole file; the last line of each is 'CHECKSUM: <code>'). After reading all eight, reply with exactly eight lines, one per file: <path>: <its CHECKSUM code>."
for attempt in 1 2; do
  r17_db snapshot "$DB" > "$OUT/r17-snap-s0.json"
  EXTRA_PATCH="$HERE/patch-r17-child.yml" run child-parent \
    "Use the subagent tool exactly once to delegate the following task to a subagent, wait for its completion notice, then reply with the subagent's eight result lines verbatim. Do not read the files yourself. Subagent task: $CHILD_TASK"
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

# ============================ round 19 scenario P ============================
# Native pressure compaction vs MC on a 100k main route (MC 65 % unchanged).
#   P-new  shipped policy: MC-led (headroom 0, ratio = MC force band 85 %);
#          the session is pushed past 65 % so MC's historian fires first and
#          no native compaction may happen below 65 %.
#   P-old  the pre-round-19 policy (compaction-basic defaults set explicitly,
#          patch-r19-dsh-default.yml): measures where native compaction fired.
export MC_E2E_MAIN_PROVIDER=opencode-go-100k
P_MODEL_KEY="opencode-go-100k/deepseek-v4.1-flash"
# Round 19 run 41586948399: DSH caps a read result at ~8 KB and the model
# ctx_reduce'd its own reads, so file pairs never got past 52 %. Now: 40
# generated ~7.6 KB files, eight per turn (~17k tokens ≈ 17 % of 100k), and the
# model is told not to drop anything — the MC historian/drops must still lead.
P_FIX="e2e-pressure-fixtures"
python3 - "$P_FIX" <<'PY'
import hashlib, os, sys
d = sys.argv[1]
os.makedirs(d, exist_ok=True)
words = ("harbor lantern meadow granite orchard copper thistle saffron glacier willow "
         "ember quartz falcon juniper marble cobalt tundra velvet cedar prism").split()
for k in range(1, 41):
    lines = [f"# round 19 pressure fixture {k}/40 (generated by ci-e2e.sh)"]
    i = 0
    while sum(len(l) + 1 for l in lines) < 7500:
        seed = hashlib.sha256(f"p{k}:{i}".encode()).digest()
        lines.append(f"{i:03d} " + " ".join(words[b % len(words)] for b in seed[:10]) + ".")
        i += 1
    lines.append(f"CHECKSUM: P19-{k}-{hashlib.sha256(f'p19-{k}'.encode()).hexdigest()[:6].upper()}")
    open(os.path.join(d, f"p{k:02d}.txt"), "w").write("\n".join(lines) + "\n")
PY
export OPENCODE_SESSION="mc-ci-pnew-$(date +%s)"
run pnew-01 "Reply with the single word: ready."
PNSID="$(session_of "$OUT/pnew-01.log")"
echo "$PNSID" > "$OUT/pnew.sid"
if [[ -n "$PNSID" ]]; then
  k=2
  for batch in 0 1 2 3 4; do  # 40 fixtures = 5 batches
    files="$(for j in 1 2 3 4 5 6 7 8; do printf '%s/p%02d.txt, ' "$P_FIX" $((batch * 8 + j)); done | sed 's/, $//')"
    name="pnew-$(printf %02d "$k")"
    run "$name" "Use the read tool to read each of these eight files (whole file each): $files. Do not call ctx_reduce or any tool other than read. Then reply with one line per file: <path>: <its CHECKSUM code>." "$PNSID"
    r17_db session "$DB" "$PNSID" 65 "$P_MODEL_KEY" > "$OUT/db-$name.json"
    k=$((k + 1))
    grep -q 'historian trigger: pct=[0-9]* threshold=65 .* fires=true' "$OUT/$name.log" && break
  done
  run "pnew-$(printf %02d "$k")" "Without calling any tool: in one sentence, how many files did you read in this session?" "$PNSID"
  decode_session "$PNSID" "$OUT/pnew-session.jsonl"
fi
export OPENCODE_SESSION="mc-ci-pold-$(date +%s)"
EXTRA_PATCH="$HERE/patch-r19-dsh-default.yml" run pold-01 "Reply with the single word: ready."
POSID="$(session_of "$OUT/pold-01.log")"
echo "$POSID" > "$OUT/pold.sid"
if [[ -n "$POSID" ]]; then
  files="$(for j in 1 2 3 4 5 6 7 8; do printf '%s/p%02d.txt, ' "$P_FIX" "$j"; done | sed 's/, $//')"
  EXTRA_PATCH="$HERE/patch-r19-dsh-default.yml" run pold-02 "Use the read tool to read each of these eight files (whole file each): $files. Do not call ctx_reduce or any tool other than read. Then reply with one line per file: <path>: <its CHECKSUM code>." "$POSID"
  files="$(for j in 9 10 11 12 13 14 15 16; do printf '%s/p%02d.txt, ' "$P_FIX" "$j"; done | sed 's/, $//')"
  EXTRA_PATCH="$HERE/patch-r19-dsh-default.yml" run pold-03 "Use the read tool to read each of these eight files (whole file each): $files. Do not call ctx_reduce or any tool other than read. Then reply with one line per file: <path>: <its CHECKSUM code>." "$POSID"
  EXTRA_PATCH="$HERE/patch-r19-dsh-default.yml" run pold-04 "Without calling any tool: in one sentence, how many files did you read in this session?" "$POSID"
  decode_session "$POSID" "$OUT/pold-session.jsonl"
fi
unset MC_E2E_MAIN_PROVIDER

# ============================ round 22 scenario L ============================
# Lock collision in real DSH (checks R9–R13): a background historian pass
# holds the compartment lease (e2e-only hold) while
#   lock-a  the native pressure backstop needs it — 36 % on this route
#           (patch-r22-lock.yml; the shipped default is 90 %) with MC's
#           execute threshold at 30 %, so the historian fires first and the
#           following reads cross 36 % during the hold: the backstop must
#           DEFER quietly (no compaction/end error) and a later pressure check
#           must retry (compact successfully or find it covered);
#   lock-b  `/compact` needs it — run at idle through the DSH command registry
#           (headless has no slash-command step), turn-end await off so the
#           pass is still holding the lease: the summarize hook must WAIT
#           (≤ 45 s) and finish (covered by the pass, or lease acquired);
#   lock-c  timeout branch, cheap: five uncovered reads (backstop back at
#           90 %, patch-r22-lock-c.yml), a fake stuck lease (20 s) and the
#           summarize wait shortened to 3 s — `/compact` must fail closed with the
#           "retry once it finishes" message and leave no lease behind;
#   lock-d  (round 23, R14) the second native compaction at idle, lease free.
# Every switch below is e2e-only (MAGIC_CONTEXT_DSH_E2E=1 gate).
export MC_E2E_MAIN_PROVIDER=opencode-go-40k
L_MODEL_KEY="opencode-go-40k/deepseek-v4.1-flash"
LP="$HERE/patch-r22-lock.yml"
lfiles() { for j in "$@"; do printf '%s/p%02d.txt, ' "$P_FIX" "$j"; done | sed 's/, $//'; }
export OPENCODE_SESSION="mc-ci-lock-$(date +%s)"
MC_HISTORIAN_THRESHOLD=30 EXTRA_PATCH="$LP" run lock-01 "Reply with the single word: ready."
LSID="$(session_of "$OUT/lock-01.log")"
echo "$LSID" > "$OUT/lock.sid"
if [[ -n "$LSID" ]]; then
  # Run 41618120979: with a 40 s hold and ten reads the deferred session
  # climbed to 78.5 % and the model's long final answer (ten checksums) ended
  # in max-tokens — the replies are now one word, the hold 15 s (publication
  # lands mid-turn, so a later pressure check of the same turn retries).
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_HISTORIAN_HOLD_MS=15000 MC_HISTORIAN_THRESHOLD=30 EXTRA_PATCH="$LP" \
    run lock-a "Use the read tool to read each of these eight files, one read call per step, in this order (whole file each): $(lfiles 17 18 19 20 21 22 23 24). Do not call ctx_reduce or any tool other than read. After the last file reply with the single word: DONE." "$LSID"
  r17_db session "$DB" "$LSID" 30 "$L_MODEL_KEY" > "$OUT/db-lock-a.json"
  # Round 23b: run 41628590609 R12 FAIL — the 36 % backstop compacted at
  # lock-b's first pre-step, the background pass then had nothing to publish
  # and released the lease at once (the hold only applied before a
  # publication), so /compact at idle saw historianBusy=false. Now the e2e
  # hold also applies to a non-publishing pass, lock-b runs with the 90 %
  # backstop (lock-c patch) so nothing natively races the pass, and the
  # idle line reports holdRemainingMs (R12 requires > 0).
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_HISTORIAN_HOLD_MS=30000 MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE=1 \
    MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS=0 MC_HISTORIAN_THRESHOLD=20 EXTRA_PATCH="$HERE/patch-r22-lock-c.yml" \
    run lock-b "Reply with the single word: ok." "$LSID"
  r17_db session "$DB" "$LSID" 20 "$L_MODEL_KEY" > "$OUT/db-lock-b.json"
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE=1 MAGIC_CONTEXT_DSH_E2E_FAKE_LEASE_MS=20000 \
    MAGIC_CONTEXT_DSH_E2E_SUMMARIZE_LEASE_WAIT_MS=3000 MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS=0 \
    MC_HISTORIAN_THRESHOLD=95 EXTRA_PATCH="$HERE/patch-r22-lock-c.yml" \
    run lock-c "Use the read tool to read each of these five files, one read call per step (whole file each): $(lfiles 27 28 29 30 31). Do not call ctx_reduce. After the last file reply with the single word: DONE." "$LSID"
  r17_db session "$DB" "$LSID" 95 "$L_MODEL_KEY" > "$OUT/db-lock-c.json"
  # Round 23 (check R14): the SECOND native compaction of this session. lock-b's
  # /compact was the first; lock-d compacts again at idle with the lease free,
  # so the summarize hook must see lock-c's reads as NOT covered (history
  # ordinals stay stable across the first checkpoint) and summarize them —
  # run 41619627652 replayed compartments 1–17 instead and shadowed them.
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE=1 MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS=0 \
    MC_HISTORIAN_THRESHOLD=95 EXTRA_PATCH="$HERE/patch-r22-lock-c.yml" \
    run lock-d "Reply with the single word: ok." "$LSID"
  r17_db session "$DB" "$LSID" 95 "$L_MODEL_KEY" > "$OUT/db-lock-d.json"
  decode_session "$LSID" "$OUT/lock-session.jsonl"
  [[ -f "$OUT/lock-session.jsonl" && -f "$OUT/db-lock-d.json" ]] && \
    bun "$HERE/ci-history.ts" "$OUT/lock-session.jsonl" "$OUT/db-lock-d.json" "read each of these five files" \
      > "$OUT/history-lock.json" 2> "$OUT/history-lock.err"
fi
unset MC_E2E_MAIN_PROVIDER

# ============================ round 26 scenario T ============================
# /compact with a historian <unprocessed_from> inside the region (limitation 17,
# P1-2): real main model, mock historian route; checks T1–T4. See ci-t.sh.
P_FIX="$P_FIX" bash "$HERE/ci-t.sh"

# ============================ round 22 scenario K ============================
# Pending restart vs hot keys in ONE long process (checks U7–U11). Headless is
# one process per turn, so the edit happens DURING a turn: k-1 reads six files
# one step at a time; as soon as the e2e status dump shows its second pre-step
# the script edits magic-context.jsonc — a restart-only key
# (memory.injection_budget_tokens 4000 → 6000) and a hot key (protected_tokens
# unset → 9000). The dump (e2e-only) records every pre-step (hot value,
# persisted protection floor, pending keys) and, at the turn end, the settings
# page view, the composer popover and `/ctx-status` executed through the DSH
# command registry. k-2 is the restart (new process, same session).
export MC_E2E_MAIN_PROVIDER=opencode-go-40k
CFG="$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc"
cp "$CFG" "$OUT/k-jsonc.orig"
kcfg() { python3 - "$CFG" "$1" "$2" <<'PY'
import json, re, sys
path, budget, prot = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = open(path).read().splitlines()
head = [l for l in lines if l.lstrip().startswith("//")]
body = "\n".join(l for l in lines if not l.lstrip().startswith("//"))
cfg = json.loads(body)
cfg.setdefault("memory", {})["injection_budget_tokens"] = budget
if prot == "unset":
    cfg.pop("protected_tokens", None)
else:
    cfg["protected_tokens"] = int(prot)
open(path, "w").write("\n".join(head) + "\n" + json.dumps(cfg, indent=2) + "\n")
PY
}
kcfg 4000 unset
cp "$CFG" "$OUT/k-jsonc.before"
KDUMP="$(cd "$OUT" && pwd)/k-dump.jsonl"
: > "$KDUMP"
export OPENCODE_SESSION="mc-ci-k-$(date +%s)"
MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_STATUS_DUMP="$KDUMP" MC_HISTORIAN_THRESHOLD=65 \
  run k-1 "Use the read tool to read each of these six files, one read call per step, in this order (whole file each): $(lfiles 31 32 33 34 35 36). Do not call ctx_reduce or any tool other than read. Then reply with one line per file: <path>: <its CHECKSUM code>." &
KPID=$!
edited=0
for i in $(seq 1 240); do
  nsteps="$(grep -c '"kind":"step"' "$KDUMP" 2>/dev/null)"; nsteps="${nsteps:-0}"
  if [[ "$nsteps" -ge 2 ]]; then
    kcfg 6000 9000
    python3 -c 'import json,time,sys; json.dump({"editedAt": int(time.time()*1000)}, open(sys.argv[1],"w"))' "$OUT/k-edit.json"
    cp "$CFG" "$OUT/k-jsonc.after"
    edited=1
    break
  fi
  kill -0 "$KPID" 2>/dev/null || break
  sleep 0.5
done
wait "$KPID"
echo "[ci-e2e] k-1: jsonc edited mid-turn: $edited"
KSID="$(session_of "$OUT/k-1.log")"
echo "$KSID" > "$OUT/k.sid"
if [[ -n "$KSID" ]]; then
  r17_db session "$DB" "$KSID" 65 "opencode-go-40k/deepseek-v4.1-flash" > "$OUT/db-k-1.json"
  echo '{"kind":"restart"}' >> "$KDUMP"
  MAGIC_CONTEXT_DSH_E2E=1 MAGIC_CONTEXT_DSH_E2E_STATUS_DUMP="$KDUMP" MC_HISTORIAN_THRESHOLD=65 \
    run k-2 "Reply with the single word: ok." "$KSID"
  r17_db session "$DB" "$KSID" 65 "opencode-go-40k/deepseek-v4.1-flash" > "$OUT/db-k-2.json"
fi
cp "$OUT/k-jsonc.orig" "$CFG"
unset MC_E2E_MAIN_PROVIDER

# ============================ round 23b scenario X ============================
# Extreme context pressure on a 24k window with the deterministic mock model
# (no key; requests priced with a real BPE count and the window enforced):
# checks X1–X8. See ci-x.sh.
bash "$HERE/ci-x.sh"

# ============================ round 26 scenario M ============================
# Legacy-data migration through the built CLI on a fixture DB in an isolated
# data dir + mock-model DSH runs before/after (P0-1); checks M1–M5. See ci-m.sh.
bash "$HERE/ci-m.sh"

# ============================ round 24b scenario H ============================
# Multi-session memory correctness on the real model (task pack P1-1): four
# facts with codewords, historian passes, restarts, new sessions, a correction
# and a never-recorded fact; checks U13–U25. See ci-h.sh.
bash "$HERE/ci-h.sh"

# --- U: doctor after all runs (shared DB opens, no live liveness markers left)
node "$HERE/../../dist/cli.js" doctor --profile test > "$OUT/doctor-after.txt" 2>&1
echo "rc=$?" >> "$OUT/doctor-after.txt"

pgrep -f 'dsh/lib/bin.js' > "$OUT/leftover-procs.txt" || true
echo "[ci-e2e] done; leftover dsh processes: $(wc -l < "$OUT/leftover-procs.txt")"
