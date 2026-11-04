#!/usr/bin/env bash
# Round 26 (P2-5) — release acceptance of the PACKED .tgz in a clean
# environment (dsh-install.yml job `accept`): nothing from the repo's
# node_modules is used; DSH comes from npm, the plugin only from the tarballs,
# installed the documented way (`dsh plugin --profile <p> add <tgz>` = pnpm in
# the profile directory).
#
#   install-accept.sh <old.tgz (dsh.2)> <new.tgz (HEAD)>
#
# Steps (each a real `dsh` headless turn on the deterministic mock model):
#   a  install OLD → setup → doctor → turn (Magic active, DB written)
#   b  upgrade to NEW → setup → doctor → --version → turn in the same session
#      (DB opens, earlier rows kept)
#   c  disable (setup --disable-preset root) → turn (no Magic line, no Magic
#      write, managed block gone)
#   d  roll back to OLD → setup → doctor → turn (or a visible schema-fence
#      refusal — recorded, never silent)
# Writes $OUT/accept.jsonl (one JSON line per step) + logs; the job judges it
# with install-accept-check.py.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OLD="$(readlink -f "$1")"
NEW="$(readlink -f "$2")"
source "$HERE/env.sh"
OUT="${CI_OUT:-$E2E_ROOT/accept}"
mkdir -p "$OUT"
: > "$OUT/accept.jsonl"
P=headless  # the flat headless template profile (single pseudo preset "root")
PDIR="$DSH_HOME/profiles/$P"
DB="$XDG_DATA_HOME/cortexkit/magic-context/context.db"
CLI() { node "$PDIR/node_modules/dsh-magic-context/dist/cli.js" "$@"; }
rec() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@" >> "$OUT/accept.jsonl"; }
dbq() { [[ -f "$DB" ]] && python3 - "$DB" "$1" <<'PY' || echo -1
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    print(c.execute(sys.argv[2]).fetchone()[0])
except Exception as e:
    print(-1)
PY
}

export MOCK_LLM_PORT=18595 MOCK_LLM_KEY=mock-not-a-secret
echo '{"a":[{"text":"DONE a"}],"b":[{"text":"DONE b"}],"c":[{"text":"DONE c"}],"d":[{"text":"DONE d"}]}' > "$OUT/plans.json"
SID=""
turn() { # turn <step>
  local s="$1"
  RUN_LOG="$OUT/turn-$s.log" PROFILE=$P EXTRA_PATCH="$HERE/model-mock.yml" MC_E2E_MAIN_PROVIDER=mock-24k \
    OPENCODE_SESSION="acc-$s-$(date +%s)" RUN_TIMEOUT=180 \
    bash "$HERE/run-headless.sh" "Reply when done. [[MOCK:$s]]" ${SID:+"$SID"} > "$OUT/turn-$s.out" 2>&1
  [[ -z "$SID" ]] && SID="$(python3 -c 'import json,sys
for l in open(sys.argv[1], errors="replace"):
    try: o=json.loads(l)
    except Exception: continue
    if o.get("type")=="session": print(o.get("sessionId","")); break' "$OUT/turn-$s.log")"
  TRC="$(tail -n 1 "$OUT/turn-$s.out" | sed -n 's/^rc=\([0-9]*\).*/\1/p')"
  TMAGIC="$(grep -c '^\[magic-context\]' "$OUT/turn-$s.log" 2>/dev/null || true)"
  TFENCE="$(grep -ci 'schema' "$OUT/turn-$s.log" 2>/dev/null || true)"
}
install_tgz() { # install_tgz <tgz> <step>
  (cd "$OUT" && timeout 300 node "$DSH_BIN" plugin --profile $P add "$1") > "$OUT/install-$2.log" 2>&1
  echo $?
}

# The mock needs ai-tokenizer: take it from the installed plugin (a runtime dep).
start_mock() {
  MOCK_TOKENIZER_ROOT="$(readlink -f "$PDIR/node_modules/dsh-magic-context"):$PDIR" node "$HERE/mock-llm.mjs" "$MOCK_LLM_PORT" "$OUT/plans.json" "$OUT/requests.jsonl" > "$OUT/mock.log" 2>&1 &
  MOCK_PID=$!
  for i in $(seq 1 40); do grep -q "listening\|Error" "$OUT/mock.log" 2>/dev/null && break; sleep 0.25; done
}

# --- a: materialise the headless profile from DSH's template, install the OLD tarball
timeout 60 node "$DSH_BIN" --profile $P --dump-default-config > "$OUT/dump-config.log" 2>&1
rc_i=$(install_tgz "$OLD" a)
start_mock
CLI setup --profile $P > "$OUT/setup-a.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-a.log" 2>&1; rc_d=$?
ver=$(CLI --version 2>/dev/null | tail -n 1)
turn a
rec step a install "$rc_i" setup "$rc_s" doctor "$rc_d" version "$ver" rc "${TRC:-x}" magicLines "$TMAGIC" \
  db "$([[ -f "$DB" ]] && echo yes || echo no)" tags "$(dbq 'select count(*) from tags')" sid "$SID" \
  mock "$(head -c 120 "$OUT/mock.log")"

# --- b: upgrade to NEW
rc_i=$(install_tgz "$NEW" b)
CLI setup --profile $P > "$OUT/setup-b.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-b.log" 2>&1; rc_d=$?
ver=$(CLI --version 2>/dev/null | tail -n 1)
tags_before=$(dbq 'select count(*) from tags')
turn b
rec step b install "$rc_i" setup "$rc_s" doctor "$rc_d" version "$ver" rc "${TRC:-x}" magicLines "$TMAGIC" \
  tagsBefore "$tags_before" tags "$(dbq 'select count(*) from tags')" integrity "$(dbq 'pragma integrity_check')"

# --- c: disable
CLI setup --profile $P --disable-preset root > "$OUT/setup-c.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-c.log" 2>&1; rc_d=$?
block="$(grep -c 'dsh-magic-context' "$PDIR/cordis.patch.yml" 2>/dev/null || true)"
tags_before=$(dbq 'select count(*) from tags')
turn c
rec step c setup "$rc_s" doctor "$rc_d" doctorDisabled "$(grep -c 'disabled in every preset' "$OUT/doctor-c.log" 2>/dev/null || true)" rc "${TRC:-x}" magicLines "$TMAGIC" patchMentions "$block" \
  tagsBefore "$tags_before" tags "$(dbq 'select count(*) from tags')"

# --- d: roll back to OLD (re-enabled)
rc_i=$(install_tgz "$OLD" d)
CLI setup --profile $P > "$OUT/setup-d.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-d.log" 2>&1; rc_d=$?
ver=$(CLI --version 2>/dev/null | tail -n 1)
tags_before=$(dbq 'select count(*) from tags')
turn d
rec step d install "$rc_i" setup "$rc_s" doctor "$rc_d" version "$ver" rc "${TRC:-x}" magicLines "$TMAGIC" schemaLines "$TFENCE" \
  tagsBefore "$tags_before" tags "$(dbq 'select count(*) from tags')" integrity "$(dbq 'pragma integrity_check')"

kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null
cat "$OUT/accept.jsonl"
