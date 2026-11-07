# Round 37 phase 2 — evo bench: how the agent's DSH process is launched (sourced by
# run.sh and probe.sh so the access probe exercises EXACTLY the launch the bench uses).
#
#   evo_isolation_setup              (once per run, after WS / SCR / DSH_HOME exist)
#   evo_dsh_turn <log> <timeout-s> <dsh args...>     (cwd = $WS)
#   evo_patch <file>                 (path of a --patch file as the launched DSH sees it)
#
# Plain launch: the DSH process (and so every tool it runs for the agent) sees the whole
# runner filesystem as the runner user — task dir, bench output, repo checkout, session
# store (known limitation 32).
evo_isolation_setup() { :; }
evo_patch() { echo "$1"; }
evo_dsh_turn() {
  local log="$1" t="$2"; shift 2
  (cd "$WS" && timeout -k 30 "$t" node "$DSH_BIN" "$@" > "$log" 2>&1)
}
