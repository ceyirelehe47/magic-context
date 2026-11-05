#!/usr/bin/env bash
# Round 26 (P2-5) — release acceptance of the PACKED .tgz in a clean
# environment (dsh-install.yml job `accept`): nothing from the repo's
# node_modules is used; DSH comes from npm, the plugin only from the tarballs,
# installed the documented way (`dsh plugin --profile <p> add <tgz>` = pnpm in
# the profile directory).
#
#   install-accept.sh <old.tgz (a released tag, default dsh.2)> <new.tgz (HEAD)>
#
# Steps (each a real `dsh` headless turn on the deterministic mock model):
#   a  install OLD → setup → doctor → turn (Magic active, DB written)
#   b  upgrade to NEW → setup → doctor → --version → turn in the same session
#      (DB opens, earlier rows kept)
#   c  disable (setup --disable-preset root) → turn (no Magic line, no Magic
#      write, managed block gone)
#   d  roll back to OLD → setup → doctor → turn (or a visible schema-fence
#      refusal — recorded, never silent)
# Round 33 (P0): step a writes a project memory (ctx_memory), steps b (NEW) and d
# (OLD) call ctx_expand over the session's first ordinals: NEW must not show Magic's
# own injected <session-history> / <project-memory> text (B5, 4a29a6bf5), OLD is the
# control. Step b also runs the CLI through the profile's pnpm .bin shim.
# Writes $OUT/accept.jsonl (one JSON line per step, plus a `meta` line with both
# tarball versions) + logs; the job judges it with install-accept-check.py.
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
cat > "$OUT/plans.json" <<'JSON'
{"a":[{"tool":"ctx_memory","args":{"action":"write","category":"PROJECT_RULES","content":"Acceptance rule ACC-RULE-7731: the ledger has exactly one writer."},"once":true},{"text":"DONE a"}],
 "b":[{"tool":"ctx_expand","args":{"start":1,"end":60},"once":true},{"text":"DONE b"}],
 "c":[{"text":"DONE c"}],
 "d":[{"tool":"ctx_expand","args":{"start":1,"end":60},"once":true},{"text":"DONE d"}]}
JSON
tgzver() { tar -xzOf "$1" package/package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'; }
rec step meta oldVersion "$(tgzver "$OLD")" newVersion "$(tgzver "$NEW")" dshInstalled "$(node -p "require('$DSH_INSTALL_DIR/package.json').version" 2>/dev/null || echo missing)"
# tool <log> <tool-name> -> JSON {status, len, injected, user, needle} of the first result of that tool
tool() { python3 - "$1" "$2" <<'PY'
import json, sys
calls, res = {}, None
for l in open(sys.argv[1], errors="replace"):
    try: o = json.loads(l)
    except Exception: continue
    if o.get("type") == "tool_call": calls[o.get("callId")] = o.get("tool")
    elif o.get("type") == "tool_result" and calls.get(o.get("callId")) == sys.argv[2] and res is None:
        r = o.get("result"); t = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
        res = {"status": o.get("status"), "len": len(t),
               "injected": sum(t.count(m) for m in ("<session-history>", "<project-memory>", "<project-docs>", "<user-profile>", "<ctx-search-hint>")),
               "user": t.count("MOCK:a"), "needle": t.count("ACC-RULE-7731")}
print(json.dumps(res or {"status": "none"}))
PY
}
J() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$1" "$2"; }
SID=""
# Round 33: ONE mock session key for all four turns. The mock tracks plan progress
# per key and follows the newest [[MOCK:x]] marker in a request; ctx_expand output
# (b, d) quotes turn a's marker, so a per-turn key would replay plan a there.
ACC_SESSION="acc-$(date +%s)"
turn() { # turn <step>
  local s="$1"
  RUN_LOG="$OUT/turn-$s.log" PROFILE=$P EXTRA_PATCH="$HERE/model-mock.yml" MC_E2E_MAIN_PROVIDER=mock-24k \
    OPENCODE_SESSION="$ACC_SESSION" RUN_TIMEOUT=180 \
    bash "$HERE/run-headless.sh" "Reply when done. [[MOCK:$s]]" ${SID:+"$SID"} > "$OUT/turn-$s.out" 2>&1
  [[ -z "$SID" ]] && SID="$(python3 -c 'import json,sys
for l in open(sys.argv[1], errors="replace"):
    try: o=json.loads(l)
    except Exception: continue
    if o.get("type")=="session": print(o.get("sessionId","")); break' "$OUT/turn-$s.log")"
  TRC="$(tail -n 1 "$OUT/turn-$s.out" | sed -n 's/^rc=\([0-9]*\).*/\1/p')"
  TMAGIC="$(grep -c '^\[magic-context\]' "$OUT/turn-$s.log" 2>/dev/null || true)"
  # Round 33 (P1-B): only core's schema-fence refusal counts (storage-db.ts "refusing to open … upstream
  # migration lane vN is newer than this binary supports"); a bare 'schema' also matched ordinary text
  # (42050299481 turn d: the ctx_expand result quoting ARCHITECTURE.md), which would have turned a broken
  # rollback into A4 WARN instead of FAIL.
  TFENCE="$(grep -cE 'refusing to open .*upstream migration lane v[0-9]+ is newer than this binary supports' "$OUT/turn-$s.log" 2>/dev/null || true)"
}
# Round 29: a tarball DECLARES the DSH releases it supports in its peers
# (HEAD: 0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1; dsh.2: 0.2.1-rc.5 only), judged by
# dsh-declared.py the way DSH's plugin manager judges them. A tarball that
# declares the running DSH gets NO exemption and its doctor must exit 0.
# Round 28b evaluation lane, now ONLY for a tarball that leaves the running DSH
# out (e.g. dsh.2 on 0.2.2-alpha.3): the plugin manager rejects it unless the
# profile holds DSH's exact-version exemption, so install_tgz grants it
# (allow-<step>.log) and, when doctor's version line is its ONLY FAIL, the
# step's doctor rc counts as 0 and the step records doctorPin=1. A0 reports
# both and FAILs if the HEAD tarball ever needs either.
declares() { python3 "$HERE/dsh-declared.py" "$1" "${DSH_VERSION:-}" >> "$OUT/declared.log" 2>&1; }
CUR_TGZ=""
PIN_ONLY=0
DRC=0
doctor_rc() { # doctor_rc <log> <rc>  -> sets DRC and PIN_ONLY (no subshell); judged for CUR_TGZ
  PIN_ONLY=0; DRC="$2"
  if [[ "$2" -ne 0 && -n "${DSH_VERSION:-}" ]] && ! declares "$CUR_TGZ" \
     && grep -q '^\[FAIL\] DSH version$' "$1" && [[ "$(grep '^\[FAIL\]' "$1" | grep -vc '^\[FAIL\] DSH version$')" == "0" ]]; then
    PIN_ONLY=1; DRC=0
  fi
}

install_tgz() { # install_tgz <tgz> <step>
  if [[ -n "${DSH_VERSION:-}" ]] && ! declares "$1"; then
    local v; v="$(tar -xzOf "$1" package/package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
    (cd "$OUT" && timeout 60 node "$DSH_BIN" plugin --profile $P allow-version "dsh-magic-context@$v" --dsh-version "$DSH_VERSION" --accept-risk) > "$OUT/allow-$2.log" 2>&1
  fi
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
CUR_TGZ="$OLD"; rc_i=$(install_tgz "$OLD" a)
start_mock
CLI setup --profile $P > "$OUT/setup-a.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-a.log" 2>&1; rc_d=$?; doctor_rc "$OUT/doctor-a.log" "$rc_d"; rc_d=$DRC; pin_a=$PIN_ONLY
ver=$(CLI --version 2>/dev/null | tail -n 1)
turn a
TA="$(tool "$OUT/turn-a.log" ctx_memory)"
rec step a memStatus "$(J "$TA" status)" install "$rc_i" setup "$rc_s" doctor "$rc_d" doctorPin "$pin_a" version "$ver" rc "${TRC:-x}" magicLines "$TMAGIC" \
  db "$([[ -f "$DB" ]] && echo yes || echo no)" tags "$(dbq 'select count(*) from tags')" sid "$SID" \
  mock "$(head -c 120 "$OUT/mock.log")"

# --- b: upgrade to NEW
CUR_TGZ="$NEW"; rc_i=$(install_tgz "$NEW" b)
CLI setup --profile $P > "$OUT/setup-b.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-b.log" 2>&1; rc_d=$?; doctor_rc "$OUT/doctor-b.log" "$rc_d"; rc_d=$DRC; pin_b=$PIN_ONLY
ver=$(CLI --version 2>/dev/null | tail -n 1)
# the CLI through the profile's pnpm .bin shim (the npm/bun symlink path: npm-bin-accept.sh)
binp=$( [[ -e "$PDIR/node_modules/.bin/dsh-magic-context" ]] && "$PDIR/node_modules/.bin/dsh-magic-context" --version 2>/dev/null | tail -n 1 || echo '<missing>')
tags_before=$(dbq 'select count(*) from tags')
turn b
TB="$(tool "$OUT/turn-b.log" ctx_expand)"
rec step b binPnpm "$binp" expandStatus "$(J "$TB" status)" expandLen "$(J "$TB" len)" expandInjected "$(J "$TB" injected)" expandUser "$(J "$TB" user)" \
  install "$rc_i" setup "$rc_s" doctor "$rc_d" doctorPin "$pin_b" version "$ver" rc "${TRC:-x}" magicLines "$TMAGIC" \
  tagsBefore "$tags_before" tags "$(dbq 'select count(*) from tags')" integrity "$(dbq 'pragma integrity_check')"

# --- c: disable
CLI setup --profile $P --disable-preset root > "$OUT/setup-c.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-c.log" 2>&1; rc_d=$?; doctor_rc "$OUT/doctor-c.log" "$rc_d"; rc_d=$DRC; pin_c=$PIN_ONLY
block="$(grep -c 'dsh-magic-context' "$PDIR/cordis.patch.yml" 2>/dev/null || true)"
tags_before=$(dbq 'select count(*) from tags')
turn c
rec step c setup "$rc_s" doctor "$rc_d" doctorPin "$pin_c" doctorDisabled "$(grep -c 'disabled in every preset' "$OUT/doctor-c.log" 2>/dev/null || true)" rc "${TRC:-x}" magicLines "$TMAGIC" patchMentions "$block" \
  tagsBefore "$tags_before" tags "$(dbq 'select count(*) from tags')"

# --- d: roll back to OLD (re-enabled)
CUR_TGZ="$OLD"; rc_i=$(install_tgz "$OLD" d)
CLI setup --profile $P > "$OUT/setup-d.log" 2>&1; rc_s=$?
CLI doctor --profile $P > "$OUT/doctor-d.log" 2>&1; rc_d=$?; doctor_rc "$OUT/doctor-d.log" "$rc_d"; rc_d=$DRC; pin_d=$PIN_ONLY
ver=$(CLI --version 2>/dev/null | tail -n 1)
tags_before=$(dbq 'select count(*) from tags')
turn d
TD="$(tool "$OUT/turn-d.log" ctx_expand)"
rec step d expandStatus "$(J "$TD" status)" expandLen "$(J "$TD" len)" expandInjected "$(J "$TD" injected)" expandUser "$(J "$TD" user)" install "$rc_i" setup "$rc_s" doctor "$rc_d" doctorPin "$pin_d" version "$ver" rc "${TRC:-x}" magicLines "$TMAGIC" schemaLines "$TFENCE" \
  tagsBefore "$tags_before" tags "$(dbq 'select count(*) from tags')" integrity "$(dbq 'pragma integrity_check')"

kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null
cat "$OUT/accept.jsonl"
