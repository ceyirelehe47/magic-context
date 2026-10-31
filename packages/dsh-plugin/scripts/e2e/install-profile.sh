#!/usr/bin/env bash
# Pack the built plugin and install it into a scratch DSH profile.
#
#   packages/dsh-plugin/scripts/e2e/install-profile.sh [profile=test] [template=headless]
#
# - creates $DSH_HOME/profiles/<profile> from the shipped <template> profile
#   (via --dump-default-config, which materialises the template);
# - extracts the `bun pm pack` tarball into the profile's node_modules;
# - symlinks the profile's node_modules/@deepseek-ai to the launcher install
#   so every @deepseek-ai/* module is ONE instance (class identity matters).
# Run `bun run build` in packages/dsh-plugin first. Then run
# `node dist/cli.js setup --profile <profile>` (adds the bundle + patch layer).
set -euo pipefail
source "$(dirname "$0")/env.sh"
PROFILE="${1:-test}"
TEMPLATE="${2:-headless}"
PKG="$REPO/packages/dsh-plugin"

timeout 60 node "$DSH_BIN" --profile "$TEMPLATE" --dump-default-config >/dev/null
PDIR="$DSH_HOME/profiles/$PROFILE"
if [[ ! -d "$PDIR" ]]; then
  cp -r "$DSH_HOME/profiles/$TEMPLATE" "$PDIR"
  sed -i "s/dsh-profile-$TEMPLATE/dsh-profile-$PROFILE/" "$PDIR/package.json"
fi
rm -f "$PKG"/dsh-magic-context-*.tgz
(cd "$PKG" && timeout 90 bun pm pack --quiet >/dev/null)
TGZ="$(ls "$PKG"/dsh-magic-context-*.tgz | head -1)"
mkdir -p "$PDIR/node_modules"
rm -rf "$PDIR/node_modules/dsh-magic-context"
mkdir -p "$PDIR/node_modules/dsh-magic-context"
tar -xzf "$TGZ" -C "$PDIR/node_modules/dsh-magic-context" --strip-components=1
rm -f "$TGZ"
ln -sfn "$E2E_ROOT/dsh/node_modules/@deepseek-ai" "$PDIR/node_modules/@deepseek-ai"
# Runtime dependencies of the package (what `dsh plugin add` / pnpm would
# hoist): ai-tokenizer supplies the real Claude encoding for token counts.
TOK="$(ls -d "$REPO"/node_modules/.bun/ai-tokenizer@*/node_modules/ai-tokenizer | head -1)"
rm -rf "$PDIR/node_modules/ai-tokenizer"
cp -r "$TOK" "$PDIR/node_modules/ai-tokenizer"
echo "installed dsh-magic-context into $PDIR"
