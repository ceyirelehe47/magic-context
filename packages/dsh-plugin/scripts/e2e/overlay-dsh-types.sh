#!/usr/bin/env bash
# Round 31 — type-level / runtime contract check against a declared DSH other
# than the lockfile's (0.2.1-rc.5). CI only (dsh-ci.yml job `contracts-dsh`):
# npm-installs `@deepseek-ai/dsh@<V>` plus every @deepseek-ai package the
# adapter imports, at <V>, into a scratch tree, then points every
# `node_modules/@deepseek-ai/*` entry of the checkout that the scratch tree also
# has at the scratch copy (symlink, so the scratch tree's own dependencies —
# cordis, zod … — resolve from there). The repo's lockfile / package.json are
# not touched; run on a throwaway CI checkout only.
# usage: overlay-dsh-types.sh <dsh-version> <scratch-dir>
set -euo pipefail
V="${1:?dsh version}"; S="${2:?scratch dir}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
PKGS=(dsh agent compaction compaction-basic llm session subagent token-meter tools typert-protocol typert-registry client-connection client-ui-primitives client-ui-slots)
mkdir -p "$S"; cd "$S"; echo '{"name":"dsh-overlay","private":true}' > package.json
specs=(); for p in "${PKGS[@]}"; do [ "$p" = dsh ] && specs+=("@deepseek-ai/dsh@$V") || specs+=("@deepseek-ai/dsh-$p@$V"); done
npm install --ignore-scripts --no-audit --no-fund "${specs[@]}" >/dev/null
SRC="$S/node_modules/@deepseek-ai"
replaced=0
for dir in "$ROOT"/node_modules/@deepseek-ai "$ROOT"/packages/*/node_modules/@deepseek-ai; do
  [ -d "$dir" ] || continue
  for entry in "$dir"/*; do
    n="$(basename "$entry")"
    [ -e "$SRC/$n" ] || continue
    before="$(node -p "require('$entry/package.json').version" 2>/dev/null || echo '?')"
    rm -rf "$entry"; ln -s "$SRC/$n" "$entry"
    after="$(node -p "require('$entry/package.json').version")"
    echo "overlay ${entry#$ROOT/}: $before -> $after"; replaced=$((replaced + 1))
  done
done
# Every DSH package the adapter imports must now be <V>.
for p in agent compaction compaction-basic llm session subagent token-meter tools typert-protocol typert-registry; do
  got=missing
  for base in "$ROOT/packages/dsh-plugin/node_modules" "$ROOT/node_modules"; do
    if [ -e "$base/@deepseek-ai/dsh-$p/package.json" ]; then got="$(node -p "require('$base/@deepseek-ai/dsh-$p/package.json').version")"; break; fi
  done
  [ "$got" = "$V" ] || { echo "overlay: @deepseek-ai/dsh-$p is $got, expected $V" >&2; exit 1; }
done
echo "overlay: $replaced entries -> DSH $V; cordis $(node -p "require('$SRC/cordis/package.json').version")"
