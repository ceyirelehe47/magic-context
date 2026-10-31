#!/usr/bin/env bash
# One real-model headless turn in the scratch profile (bounded, logs to file).
#
#   run-headless.sh "<task>" [session-id]        -> $E2E_ROOT/logs/run-<n>.log
#
# Env knobs: PROFILE (test), EXTRA_PATCH (extra --patch file),
# MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS (default 60000 here),
# MC_HISTORIAN_THRESHOLD (historian trigger %, default 40), RUN_TIMEOUT (240s).
set -euo pipefail
source "$(dirname "$0")/env.sh"
TASK="$1"
SID="${2:-}"
PROFILE="${PROFILE:-test}"
mkdir -p "$E2E_ROOT/logs"
export OPENCODE_SESSION="${OPENCODE_SESSION:-mc-e2e-$(date +%s)}"
export MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS="${MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS:-60000}"
export MAGIC_CONTEXT_DEBUG_HISTORIAN="${MAGIC_CONTEXT_DEBUG_HISTORIAN:-1}"
N=$(ls "$E2E_ROOT/logs" | grep -c '^run-' || true)
LOG="$E2E_ROOT/logs/run-$((N + 1)).log"
ARGS=(--profile "$PROFILE" --patch "$(dirname "$0")/model-opencode-go.yml")
[[ -n "${EXTRA_PATCH:-}" ]] && ARGS+=(--patch "$EXTRA_PATCH")
ARGS+=("$TASK" --json)
[[ -n "$SID" ]] && ARGS+=(--session-id "$SID")
START=$(date +%s.%N)
set +e
timeout "${RUN_TIMEOUT:-240}" node "$DSH_BIN" "${ARGS[@]}" >"$LOG" 2>&1
RC=$?
set -e
END=$(date +%s.%N)
echo "rc=$RC elapsed=$(python3 -c "print(round($END-$START,1))")s log=$LOG" | tee -a "$LOG"
