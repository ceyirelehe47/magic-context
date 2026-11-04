#!/usr/bin/env bash
# Round 26 scenario M — legacy-data migration (task pack P0-1, known
# limitations 19/20) through the BUILT CLI (`node dist/cli.js migrate-legacy`)
# on a legacy fixture DB in an ISOLATED data dir (E2E_XDG_DATA_HOME), plus real
# DSH runs on the deterministic mock model (no key) that show what reaches the
# model before and after. Checks M1–M5 in ci-check.py. Called by ci-e2e.sh.
#   m-pre    new DSH session BEFORE the migration (the raw-path fact is not injected)
#   scan / --dry-run (read-only: logical digest unchanged)
#   --apply (backup, one transaction), --apply again (idempotent)
#   --restore <backup> (digest MATCH = the pre-apply DB), --apply once more
#   m-post   new DSH session AFTER: the migrated fact reaches the model, the
#            cancelled fact still does not
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/ci}"
mkdir -p "$OUT"
touch "$OUT/runs.tsv"
MDATA="$E2E_ROOT/xdg-m/data"
MS="$MDATA/cortexkit/magic-context"
MDB="$MS/context.db"
rm -rf "$E2E_ROOT/xdg-m"
mkdir -p "$MS"
PROJ="$(pwd)"
CLI="node $(cd "$HERE/../.." && pwd)/dist/cli.js migrate-legacy --storage-dir $MS"

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
mrun() { # mrun <name> <task>   (mock model, isolated data dir)
  local name="$1" task="$2" log
  E2E_XDG_DATA_HOME="$MDATA" EXTRA_PATCH="$HERE/model-mock.yml" MC_E2E_MAIN_PROVIDER=mock-24k MC_HISTORIAN_THRESHOLD=95 \
    OPENCODE_SESSION="mc-ci-$name-$(date +%s)" bash "$HERE/run-headless.sh" "$task" > "$OUT/$name.out" 2>&1
  log="$(tail -n 1 "$OUT/$name.out" | sed -n 's/.*log=//p')"
  if [[ -n "$log" && -f "$log" ]]; then cp "$log" "$OUT/$name.log"; else cp "$OUT/$name.out" "$OUT/$name.log"; fi
  printf '%s\t%s\t%s\n' "$name" "$(session_of "$OUT/$name.log")" "$(tail -n 1 "$OUT/$name.out")" >> "$OUT/runs.tsv"
  echo "[ci-m] $name: $(tail -n 1 "$OUT/$name.out")"
}
cli() { # cli <name> [args...]  -> $OUT/m-<name>.txt + rc line
  local name="$1"; shift
  $CLI "$@" > "$OUT/m-$name.txt" 2>&1
  echo "rc=$?" >> "$OUT/m-$name.txt"
  echo "[ci-m] cli $name: $(tail -n 1 "$OUT/m-$name.txt")"
}
digest() { bun "$HERE/ci-m.ts" digest "$MDB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])'; }

bun "$HERE/ci-m.ts" fixture "$MDB" "$PROJ" > "$OUT/m-fixture.json" 2> "$OUT/m-fixture.err"
echo "[ci-m] fixture: $(head -c 300 "$OUT/m-fixture.json")"

export MOCK_LLM_PORT=18579 MOCK_LLM_KEY=mock-not-a-secret
TOKROOT="$(cd "$HERE/../.." && pwd)"
echo '{"m1":[{"text":"DONE m1"}],"m2":[{"text":"DONE m2"}]}' > "$OUT/m-plans.json"
MOCK_LOG_NEEDLES="ARCH-KESTREL-4127,TODO-BISON-9074,RULE-MARMOT-5830" MOCK_TOKENIZER_ROOT="$TOKROOT" \
  node "$HERE/mock-llm.mjs" "$MOCK_LLM_PORT" "$OUT/m-plans.json" "$OUT/m-requests.jsonl" > "$OUT/m-mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 40); do grep -q listening "$OUT/m-mock.log" 2>/dev/null && break; sleep 0.25; done

mrun m-pre "Reply when done. [[MOCK:m1]]"
bun "$HERE/ci-m.ts" state "$MDB" "$PROJ" > "$OUT/m-state-pre.json"
D0="$(digest)"
cli scan
D1="$(digest)"
cli dry --dry-run
D2="$(digest)"
cli apply --apply
D3="$(digest)"
bun "$HERE/ci-m.ts" state "$MDB" "$PROJ" > "$OUT/m-state-apply.json"
cli apply2 --apply
D4="$(digest)"
BK="$(sed -n 's/.*--restore \(\S*\).*/\1/p' "$OUT/m-apply.txt" | head -n 1)"
cli restore --restore "$BK"
D5="$(digest)"
bun "$HERE/ci-m.ts" state "$MDB" "$PROJ" > "$OUT/m-state-restore.json"
cli apply3 --apply
bun "$HERE/ci-m.ts" state "$MDB" "$PROJ" > "$OUT/m-state-final.json"
mrun m-post "Reply when done. [[MOCK:m2]]"
printf '{"pre":"%s","scan":"%s","dry":"%s","apply":"%s","apply2":"%s","restore":"%s","backup":"%s"}\n' \
  "$D0" "$D1" "$D2" "$D3" "$D4" "$D5" "$([[ -n "$BK" && -f "$BK" ]] && echo present || echo missing)" > "$OUT/m-digests.json"
kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null
echo "[ci-m] done: $(cat "$OUT/m-digests.json")"
