# Source me: isolated DSH e2e environment (no global ~/.dsh, no global XDG).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
export E2E_ROOT="${E2E_ROOT:-$HOME/w/e2e}"
export PATH="$HOME/.bun/bin:$PATH"
export DSH_HOME="$E2E_ROOT/home"
export XDG_CONFIG_HOME="$E2E_ROOT/xdg/config"
export XDG_DATA_HOME="${E2E_XDG_DATA_HOME:-$E2E_ROOT/xdg/data}"  # round 26 scenario M: an isolated data dir
export XDG_STATE_HOME="$E2E_ROOT/xdg/state"
export XDG_CACHE_HOME="$E2E_ROOT/xdg/cache"
export DSH_TELEMETRY_DISABLED=1
export DSH_BIN="$E2E_ROOT/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
export DSH_INSTALL_DIR="$E2E_ROOT/dsh/node_modules/@deepseek-ai/dsh"
mkdir -p "$DSH_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
