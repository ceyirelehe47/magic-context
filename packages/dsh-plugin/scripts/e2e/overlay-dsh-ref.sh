#!/usr/bin/env bash
# Round 32 — EVALUATION ONLY (dsh-ref-eval.yml, manual): check the adapter against
# DSH packages built from a git ref of deepseek-ai/deepseek-harness (e.g. master,
# ahead of the newest npm release) without building the whole DSH monorepo.
#
#   1. overlay-dsh-types.sh <base-version>: npm-installs the released DSH <base>
#      into <scratch> and points the checkout's @deepseek-ai entries at it;
#   2. partial-clones the DSH repo at <ref> (blob:none + sparse) and, for every
#      package directory given, compiles its src/ with tsc (emit JS + .d.ts into
#      lib/types, like the published layout; const enums such as cordis
#      FiberState are inlined) against the <base> tree, then replaces that
#      package's lib/ inside <scratch> (never the repo's own node_modules files);
#   3. prints the ref's vendor cordis / loader / include versions next to the
#      installed ones — vendor packages are NOT rebuilt (a difference is reported
#      for the reader, it does not fail the lane).
#
# The result is a mixed tree: the listed packages at <ref>, everything else at
# <base>. Never use it as a support claim; it only shows where the adapter would
# break first. Run on a throwaway checkout (CI) only.
# usage: overlay-dsh-ref.sh <base-version> <dsh-ref> <scratch-dir> <pkg-dir>...
#   pkg-dir is relative to the DSH repo's packages/, e.g. core/agent subagent/subagent
set -euo pipefail
BASE="${1:?base dsh version}"; REF="${2:?dsh git ref}"; S="${3:?scratch dir}"; shift 3
[ "$#" -gt 0 ] || { echo "overlay-dsh-ref: no package directories given" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../../.." && pwd)"
REPO="${DSH_REPO_URL:-https://github.com/deepseek-ai/deepseek-harness.git}"
if [ "${SKIP_BASE:-0}" != 1 ]; then bash "$HERE/overlay-dsh-types.sh" "$BASE" "$S"; fi
NM="$S/node_modules/@deepseek-ai"
SRC="$S/dsh-src"
rm -rf "$SRC"
git init --quiet "$SRC"
git -C "$SRC" remote add origin "$REPO"
git -C "$SRC" sparse-checkout init --no-cone
{ echo '/package.json'; echo '/vendor/*/package.json'; for d in "$@"; do echo "/packages/$d/src/"; echo "/packages/$d/package.json"; done; } > "$SRC/.git/info/sparse-checkout"
git -C "$SRC" fetch --quiet --depth 1 --filter=blob:none origin "$REF"
git -C "$SRC" checkout --quiet FETCH_HEAD
echo "dsh-ref: $REF = $(git -C "$SRC" rev-parse HEAD) (root version $(node -p "require('$SRC/package.json').version"), engines.node $(node -p "JSON.stringify(require('$SRC/package.json').engines?.node)"))"
for v in cordis:cordis loader:cordis-plugin-loader include:cordis-plugin-include; do
  d="${v%%:*}"; n="${v##*:}"
  at_ref="$(node -p "require('$SRC/vendor/$d/package.json').version")"
  inst="$(node -p "require('$NM/$n/package.json').version" 2>/dev/null || echo missing)"
  [ "$at_ref" = "$inst" ] && echo "vendor $n: ref $at_ref = installed" || echo "vendor $n: ref $at_ref != installed $inst (NOT rebuilt)"
done
TSC="$ROOT/packages/dsh-plugin/node_modules/.bin/tsc"
TYPES_NODE="$(cd "$(dirname "$(readlink -f "$ROOT/packages/dsh-plugin/node_modules/@types/node/package.json")")/.." && pwd)"
# Compile in a trimmed tree (the adapter's DSH packages + their peers, no
# @deepseek-ai/dsh meta package): next to the full <base> tree tsc follows far
# more declarations — run 42033780423 hit node's ~4 GB heap on dsh-agent. The
# output is then copied into the full tree.
BB="$S/build-base"; mkdir -p "$BB"
( cd "$BB" && echo '{"name":"dsh-ref-build","private":true}' > package.json && \
  npm install --ignore-scripts --no-audit --no-fund \
    $(for p in agent compaction compaction-basic llm session subagent token-meter tools typert-protocol typert-registry agent-preset-registry permission-presets sandbox-policy session-persistence session-query workspace; do printf '@deepseek-ai/dsh-%s@%s ' "$p" "$BASE"; done) >/dev/null )
B="$BB/ref-build"; mkdir -p "$B"
for d in "$@"; do
  name="$(node -p "require('$SRC/packages/$d/package.json').name")"; short="${name#@deepseek-ai/}"
  dst="$NM/$short"
  # Round 33 (P1-B): a requested package that cannot be overlaid fails the lane
  # (it used to be skipped on stderr only, and the lane stayed green on <base>).
  [ -d "$dst" ] || { echo "dsh-ref: $name is not in the $BASE tree; cannot evaluate it at $REF" | tee /dev/stderr; exit 1; }
  w="$B/$short"; rm -rf "$w"; mkdir -p "$w"
  cp -r "$SRC/packages/$d/src" "$w/src"; cp "$SRC/packages/$d/package.json" "$w/package.json"
  cat > "$w/tsconfig.json" <<J
{ "compilerOptions": { "target": "es2024", "module": "esnext", "moduleResolution": "bundler",
  "declaration": true, "skipLibCheck": true, "esModuleInterop": true, "allowImportingTsExtensions": true,
  "rewriteRelativeImportExtensions": true, "strict": true, "exactOptionalPropertyTypes": true,
  "noUncheckedIndexedAccess": true, "noImplicitOverride": true, "rootDir": "src", "outDir": "lib/types",
  "typeRoots": ["$TYPES_NODE"], "types": ["node"], "noEmitOnError": false, "jsx": "react-jsx" },
  "include": ["src"], "exclude": ["src/**/*.test.ts", "src/**/*.spec.ts", "src/client/**"] }
J
  # The build dir sits under $BB so its imports resolve to the trimmed <base> tree.
  (cd "$w" && NODE_OPTIONS="--max-old-space-size=${DSH_REF_TSC_HEAP_MB:-8192}" "$TSC" -p tsconfig.json > tsc.log 2>&1) || true
  errs="$(grep -c 'error TS' "$w/tsc.log" || true)"
  [ -f "$w/lib/types/index.js" ] || { echo "dsh-ref: $name produced no lib/types/index.js" >&2; cat "$w/tsc.log" >&2; exit 1; }
  echo "export * from './types/index.js';" > "$w/lib/index.js"
  rm -rf "$dst/lib/types" "$dst/lib/index.js"
  cp -r "$w/lib/types" "$dst/lib/types"; cp "$w/lib/index.js" "$dst/lib/index.js"
  node -e "const fs=require('fs');const b=require('$dst/package.json');const r=require('$w/package.json');b.exports=r.exports;fs.writeFileSync('$dst/package.json',JSON.stringify(b,null,2))"
  # src/ modules that read '../package.json' (dsh-llm attribution) resolve it next to
  # lib/types in this unbundled layout.
  cp "$dst/package.json" "$dst/lib/package.json"
  echo "dsh-ref: $name <- $REF ($errs tsc errors in the DSH source build; exports from the ref)"
  [ "$errs" = 0 ] || sed -n '1,20p' "$w/tsc.log"
done
