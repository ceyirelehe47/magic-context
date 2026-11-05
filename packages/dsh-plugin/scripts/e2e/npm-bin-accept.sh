#!/usr/bin/env bash
# Round 33 (P0) — npm path of a packed tarball, next to a DSH installed from npm
# (dsh-install.yml job `accept`). Two round-31 defects only surface here:
#   B2  npm resolves the plugin's cordis peers against the cordis DSH depends on
#       (pnpm, the `dsh plugin add` path, only warns) -> ERESOLVE on alpha.3 / rc.1
#   B4  npm / bun install the bin as a SYMLINK (node_modules/.bin); node keeps the
#       link path in argv[1] -> the CLI exited 0 and printed nothing
#
#   npm-bin-accept.sh <dsh-dir> <label>=<tgz> [<label>=<tgz> ...]
#
# For each tarball: copy <dsh-dir> (a clean npm project holding only
# @deepseek-ai/dsh@$DSH_VERSION) — or, for a label ending in `-alone`, start from an
# EMPTY npm project (the bin probe without the DSH tree, so B4 is visible even where
# B2-style resolution fails) — `npm install <tgz>` in it — NO --force, NO
# --legacy-peer-deps — then run the CLI four ways (exec the .bin link, node on the
# .bin link, node on dist/cli.js, npx). Writes $OUT/npm-bin.jsonl (one JSON line per
# tarball) + npm-<label>.log; judged by install-accept-check.py (A5, A6, C5, C6).
set -uo pipefail
DSH_DIR="$(readlink -f "$1")"; shift
OUT="${CI_OUT:?CI_OUT}"
mkdir -p "$OUT"
: > "$OUT/npm-bin.jsonl"
for spec in "$@"; do
  label="${spec%%=*}"; tgz="$(readlink -f "${spec#*=}")"
  want="$(tar -xzOf "$tgz" package/package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
  W="$RUNNER_TEMP/npm-$label"; rm -rf "$W"
  if [[ "$label" == *-alone ]]; then mkdir -p "$W"; echo '{"name":"npm-alone","private":true}' > "$W/package.json"; else cp -a "$DSH_DIR" "$W"; fi
  (cd "$W" && timeout 300 npm install --no-audit --no-fund "$tgz") > "$OUT/npm-$label.log" 2>&1; rc=$?
  eres="$(grep -c 'ERESOLVE' "$OUT/npm-$label.log" || true)"
  L="$W/node_modules/.bin/dsh-magic-context"
  link=0; [[ -L "$L" ]] && link=1
  run() { (cd "$W" && timeout 60 "$@" 2>>"$OUT/npm-$label.cli.err" | tail -n 1); }
  vexec="$( [[ -e "$L" ]] && run "$L" --version || echo '<missing>')"
  vnode="$( [[ -e "$L" ]] && run node "$L" --version || echo '<missing>')"
  vdirect="$( [[ -f "$W/node_modules/dsh-magic-context/dist/cli.js" ]] && run node "$W/node_modules/dsh-magic-context/dist/cli.js" --version || echo '<missing>')"
  vnpx="$( [[ -e "$L" ]] && run npx --no-install dsh-magic-context --version || echo '<missing>')"
  # doctor through the link must say SOMETHING (B4 printed nothing); a missing profile is fine
  # (doctor exits non-zero on the missing profile; with pipefail only wc's count is kept)
  dlines=0; [[ -e "$L" ]] && dlines="$(cd "$W" && { timeout 60 node "$L" doctor --profile npm-accept-none 2>&1 || true; } | wc -l)"
  target="$( [[ -L "$L" ]] && readlink "$L" || echo '')"
  python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' \
    label "$label" want "$want" npmRc "$rc" eresolve "$eres" link "$link" linkTarget "$target" \
    vexec "$vexec" vnode "$vnode" vdirect "$vdirect" vnpx "$vnpx" doctorLines "$dlines" \
    dsh "$(node -p "require('$W/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo missing)" \
    cordis "$(node -p "require('$W/node_modules/@deepseek-ai/cordis/package.json').version" 2>/dev/null || echo missing)" \
    >> "$OUT/npm-bin.jsonl"
done
cat "$OUT/npm-bin.jsonl"
