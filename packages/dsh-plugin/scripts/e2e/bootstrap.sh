#!/usr/bin/env bash
# Rebuild the DSH × Magic Context dev/e2e environment from scratch on Linux.
#
#   packages/dsh-plugin/scripts/e2e/bootstrap.sh            # deps + local DSH
#
# Layout (override with E2E_ROOT): $E2E_ROOT/dsh  = isolated @deepseek-ai/dsh
# install (bun, not npm: npm is OOM-killed on small sandboxes), $E2E_ROOT/home
# = scratch DSH_HOME, $E2E_ROOT/xdg = XDG dirs (Magic SQLite + user config).
# Every step is bounded (timeout) so a single call never hangs a sandbox.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
E2E_ROOT="${E2E_ROOT:-$HOME/w/e2e}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.5}"
BUN_VERSION="${BUN_VERSION:-1.4.4}"
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | timeout 90 bash -s "bun-v$BUN_VERSION" >/dev/null
fi

# Filtered workspace install: only the lanes the DSH adapter needs.
(cd "$REPO" && timeout "${INSTALL_TIMEOUT:-100}" bun install --ignore-scripts --backend=hardlink \
  --filter '@cortexkit/opencode-magic-context' --filter '@cortexkit/retina-local-fs' \
  --filter 'dsh-magic-context-adapter' --filter 'dsh-magic-context')

mkdir -p "$E2E_ROOT/dsh" "$E2E_ROOT/home" "$E2E_ROOT/xdg"/{config,data,state,cache}
if [[ ! -x "$E2E_ROOT/dsh/node_modules/.bin/dsh" ]]; then
  echo '{"name":"dsh-e2e","private":true}' > "$E2E_ROOT/dsh/package.json"
  (cd "$E2E_ROOT/dsh" && timeout "${INSTALL_TIMEOUT:-100}" bun add --backend=hardlink "@deepseek-ai/dsh@$DSH_VERSION")
fi
echo "bootstrap ok: repo=$REPO e2e=$E2E_ROOT"
