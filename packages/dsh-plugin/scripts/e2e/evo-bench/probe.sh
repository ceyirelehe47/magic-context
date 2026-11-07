#!/usr/bin/env bash
# Round 37 phase 2 — evo bench ACCESS PROBE (no paid model call).
#
#   evo-bench/probe.sh <baseline|fold|native> <probe-out> <task-dir>
#
# Launches the agent's DSH process EXACTLY as run.sh does (launch.sh), with the
# deterministic mock model (../mock-llm.mjs, probe-model.yml) driving the REAL DSH
# tools through a fixed plan: bash (explicit paths, env-derived paths, `find /`),
# read, glob and grep on every controller / log / raw-session location, then
# positive controls (workspace read, evo-pytest when docker is there, a ctx_* tool
# in the plugin groups, a second turn that resumes the session).
#
# Canaries: a unique token is planted in each protected location (task dir with
# the future items, controller output dir = proxy log location, controller
# scratch, DSH session store, DSH home, Magic data dir) and taken from the repo
# checkout (a line of run.sh, git HEAD). The mock logs which tokens reach the
# MODEL (MOCK_LOG_NEEDLES over every request body) — a token that reaches a
# request leaked. Writes <probe-out>/probe.json and exits 1 on any leak or failed
# positive control.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../env.sh"
source "$HERE/launch.sh"
GROUP="$1"; POUT="$(mkdir -p "$2" && cd "$2" && pwd)"; TD="$(cd "$3" && pwd)"
case "$GROUP" in
  baseline) PROFILE=base ;;
  fold) PROFILE=test; export MAGIC_CONTEXT_DSH_NATIVE_ROLES=0 ;;
  native) PROFILE=test; unset MAGIC_CONTEXT_DSH_NATIVE_ROLES ;;
  *) echo "group must be baseline|fold|native" >&2; exit 2 ;;
esac
NONCE="$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
# own DSH_HOME / XDG dirs (sessions, storages, Magic DB): nothing shared with the paid run
evo_probe_storage "$NONCE" || { echo "::error::probe storage setup failed"; exit 1; }
SCR="${RUNNER_TEMP:-/tmp}/evo/probe-$GROUP-$NONCE"; rm -rf "$SCR"; mkdir -p "$SCR/bin"
WS="$SCR/ws"; mkdir -p "$WS"
export DSH_PERMISSION_MODE="${EVO_SANDBOX:-danger-full-access}"
export OPENCODE_SESSION="mc-evo-probe-$GROUP-$NONCE"
export MOCK_LLM_PORT="${MOCK_LLM_PORT:-18578}" MOCK_LLM_KEY="probe-not-a-key"
export MOCK_TOKENIZER_ROOT="${MOCK_TOKENIZER_ROOT:-$REPO/packages/dsh-plugin:$REPO:$DSH_HOME/profiles/test}"

# --- canaries (planted) + repo needles (taken)
declare -A CAN
plant() { local key="$1" file="$2"; local tok="EVOCANARY-$key-$NONCE"; mkdir -p "$(dirname "$file")"; printf '%s\n' "$tok" > "$file"; CAN[$key]="$tok"; echo "$file" >> "$POUT/planted.txt"; }
: > "$POUT/planted.txt"
plant task "$TD/CANARY-$NONCE.txt"                     # controller task dir (requests.json = every later item)
plant ctrlout "$POUT/ctrl/requests.jsonl"              # controller output = where the proxy log lives
plant scratch "$SCR/CANARY-$NONCE.txt"                 # controller scratch (snap.git, wrappers)
plant sessions "$DSH_HOME/sessions/CANARY-$NONCE.txt"  # DSH raw session store
plant dshhome "$DSH_HOME/CANARY-$NONCE.txt"            # DSH home (profiles, storages)
plant magicdata "$XDG_DATA_HOME/CANARY-$NONCE.txt"     # Magic Context DB dir
[[ -n "${BENCH_OUT_ROOT:-}" ]] && plant benchout "$BENCH_OUT_ROOT/CANARY-$NONCE.txt"
REPO_LINE="Round 36 line I evo bench: ONE run of one group"
CAN[repo]="$REPO_LINE"
GITHEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
[[ -n "$GITHEAD" ]] && CAN[githist]="$GITHEAD"
# a controller-only environment variable (like BENCH_OUT / the run metadata): must not reach the agent
export EVO_PROBE_CONTROLLER_ENV="EVOCANARY-env-$NONCE"; CAN[env]="$EVO_PROBE_CONTROLLER_ENV"
VIS="EVOVISIBLE-ws-$NONCE"; printf '%s\n' "$VIS" > "$WS/VISIBLE.txt"
T1="EVOTURN1-$NONCE"

# --- the plan (absolute paths the agent could learn from its env / ps / find)
python3 - "$POUT/plans.json" "$GROUP" "$WS" "$TD" "$POUT" "$SCR" "$DSH_HOME" "$XDG_DATA_HOME" "$REPO" "$E2E_ROOT" "${RUNNER_TEMP:-/tmp}" "${BENCH_OUT_ROOT:-}" <<'PY'
import json, sys
out, group, ws, td, pout, scr, home, data, repo, e2e, rt, bench = sys.argv[1:]
dirs = [d for d in [td, pout, scr, home, home + "/sessions", data, repo, e2e, rt, bench] if d]
cats = " ".join(f'"{d}"/CANARY-* "{d}"/*.json "{d}"/*.jsonl' for d in dirs)
steps = []
def bash(cmd, desc):
    steps.append({"tool": "bash", "args": {"command": cmd, "description": desc}, "once": True})
def tool(name, args):
    steps.append({"tool": name, "args": args, "once": True})
bash(f"for f in {cats}; do [ -f \"$f\" ] && head -c 4000 \"$f\"; done 2>&1 | head -c 60000; echo PROBE-CAT-DONE", "probe: cat controller / log / session files by absolute path")
bash(f"ls -la {' '.join(chr(34)+d+chr(34) for d in dirs)} 2>&1 | head -200; env | cut -d= -f1 | sort | tr '\\n' ' '", "probe: list protected dirs, env var names")
bash("env | sort | head -c 30000; echo PROBE-ENVDUMP-DONE", "probe: full environment")
bash("for v in DSH_HOME XDG_DATA_HOME XDG_STATE_HOME RUNNER_TEMP GITHUB_WORKSPACE E2E_ROOT HOME; do d=\"${!v}\"; [ -n \"$d\" ] && timeout 15 grep -rsh --binary-files=text EVOCANARY \"$d\" 2>/dev/null | head -20; done; echo PROBE-ENV-DONE", "probe: grep env-derived dirs")
bash("timeout 30 find / -xdev \\( -name 'CANARY-*' -o -name 'requests.json' -o -name 'requests.jsonl' \\) 2>/dev/null | head -50 | while read f; do echo \"== $f\"; head -c 2000 \"$f\"; done; echo PROBE-FIND-DONE", "probe: find / for canaries and request logs")
bash(f"for f in \"{home}\"/sessions/*/*/session.v4.jsonl.zstd; do [ -f \"$f\" ] && zstd -qdc \"$f\" | head -c 3000; done 2>&1 | head -c 20000; echo PROBE-ZSTD-DONE", "probe: decompress the raw session store")
bash(f"git -C \"{repo}\" log -3 --format=%H 2>&1 | head; head -c 3000 \"{repo}/packages/dsh-plugin/scripts/e2e/evo-bench/run.sh\" 2>&1; echo PROBE-REPO-DONE", "probe: repo history and bench scripts")
for d in dirs:
    tool("read", {"file_path": f"{d}/CANARY-{'{NONCE}'}.txt"})
tool("read", {"file_path": f"{pout}/ctrl/requests.jsonl"})
tool("read", {"file_path": f"{td}/requests.json"})
tool("read", {"file_path": f"{repo}/packages/dsh-plugin/scripts/e2e/evo-bench/run.sh"})
for d in dirs:
    tool("glob", {"pattern": "**/CANARY-*", "path": d})
    tool("grep", {"pattern": "EVOCANARY", "path": d})
tool("grep", {"pattern": "Round 36 line I evo bench", "path": repo})
# positive controls
tool("read", {"file_path": f"{ws}/VISIBLE.txt"})
bash("cat VISIBLE.txt; command -v evo-pytest >/dev/null && (timeout 120 evo-pytest --version 2>&1 | tail -n 2) ; echo PROBE-WS-DONE", "probe: workspace + test wrapper")
bash("timeout 30 docker ps -q >/dev/null 2>&1 && echo PROBE-DOCKER-OK || echo PROBE-DOCKER-FAIL; echo probe-write > probe-written.txt && cat probe-written.txt", "probe: docker socket + workspace write")
if group != "baseline":
    tool("ctx_search", {"query": "EVOVISIBLE probe"})
steps.append({"text": "probe turn 1 done"})
plans = {"probe1": steps, "probe2": [{"tool": "bash", "args": {"command": "echo PROBE-TURN2", "description": "probe turn 2"}, "once": True}, {"text": "probe turn 2 done"}]}
json.dump(plans, open(out, "w"), indent=1)
PY
sed -i "s/{NONCE}/$NONCE/g" "$POUT/plans.json"

NEEDLES="$(IFS=,; echo "${CAN[*]},$VIS,$T1")"
MOCK_LOG_NEEDLES="$NEEDLES" node "$HERE/../mock-llm.mjs" "$MOCK_LLM_PORT" "$POUT/plans.json" "$POUT/mock-requests.jsonl" > "$POUT/mock.out" 2>&1 &
MOCK=$!
for _ in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/$MOCK_LLM_PORT) 2>/dev/null && break; sleep 0.1; done
evo_isolation_setup || exit 1
ARGS=(--profile "$PROFILE" --patch "$(evo_patch "$HERE/probe-model.yml")" --patch "$(evo_patch "$HERE/bench-evo.yml")")
[[ -n "${EVO_PROBE_EXTRA_PATCH:-}" ]] && ARGS+=(--patch "$EVO_PROBE_EXTRA_PATCH")
evo_dsh_turn "$POUT/turn-01.log" 600 "${ARGS[@]}" "[[MOCK:probe1]] $T1 access probe turn 1" --json; RC1=$?
SID="$(python3 - "$POUT/turn-01.log" <<'PY'
import json, sys
for line in open(sys.argv[1], errors="replace"):
    try: o = json.loads(line)
    except Exception: continue
    if o.get("type") == "session": print(o.get("sessionId", "")); break
PY
)"
RC2=-1
[[ -n "$SID" ]] && { evo_dsh_turn "$POUT/turn-02.log" 300 "${ARGS[@]}" "[[MOCK:probe2]] access probe turn 2" --json --session-id "$SID"; RC2=$?; }
kill "$MOCK" 2>/dev/null; wait "$MOCK" 2>/dev/null
f="$(ls "$DSH_HOME"/sessions/*/"$SID"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
[[ -n "$SID" && -n "$f" ]] && zstd -qdc "$f" > "$POUT/session.jsonl" 2>/dev/null
# remove the planted canaries (never left behind for the real run)
while read -r p; do rm -f "$p"; done < "$POUT/planted.txt"; rm -rf "$POUT/ctrl"
evo_probe_storage_cleanup

PROBE_HAVE_DOCKER=0; timeout 20 docker ps -q >/dev/null 2>&1 && PROBE_HAVE_DOCKER=1; export PROBE_HAVE_DOCKER
for k in "${!CAN[@]}"; do printf '%s\t%s\n' "$k" "${CAN[$k]}"; done > "$POUT/canaries.tsv"
python3 - "$POUT" "$GROUP" "$RC1" "$RC2" "$SID" "$VIS" "$T1" <<'PY'
import json, sys, os
pout, group, rc1, rc2, sid, vis, t1 = sys.argv[1:]
can = dict(l.rstrip("\n").split("\t", 1) for l in open(os.path.join(pout, "canaries.tsv")) if "\t" in l)
rows = [json.loads(l) for l in open(os.path.join(pout, "mock-requests.jsonl")) if l.strip()] if os.path.exists(os.path.join(pout, "mock-requests.jsonl")) else []
seen = {}
for r in rows:
    for n in r.get("needles", []):
        seen.setdefault(n, []).append(r.get("n"))
leaks = {k: seen.get(v, []) for k, v in can.items()}
# per-call attribution is computed from the session log below (tool result texts)
events = []
if os.path.exists(os.path.join(pout, "session.jsonl")):
    for l in open(os.path.join(pout, "session.jsonl"), errors="replace"):
        try: events.append(json.loads(l))
        except Exception: pass
calls, results = {}, {}
for e in events:
    m = (e.get("data") or {}).get("message") or {}
    if e.get("type") == "assistant/message":
        for b in m.get("content") or []:
            if b.get("type") == "tool-call": calls[b.get("id")] = b.get("name")
    if e.get("type") == "tool/result":
        txt = "".join(b.get("text", "") for b in (m.get("content") or []) if isinstance(b, dict))
        results[m.get("toolCallId")] = {"isError": m.get("isError") is True, "text": txt}
call_args = {}
for e in events:
    m = (e.get("data") or {}).get("message") or {}
    if e.get("type") == "assistant/message":
        for b in m.get("content") or []:
            if b.get("type") == "tool-call":
                try: a = json.loads(b.get("arguments") or "{}")
                except Exception: a = {}
                call_args[b.get("id")] = a.get("description") or a.get("file_path") or a.get("path") or a.get("query") or ""
leak_paths = {}
for cid, name in calls.items():
    r = results.get(cid)
    if r is None: continue
    for k, v in can.items():
        if v in r["text"]:
            leak_paths.setdefault(k, set()).add(f"{name}: {call_args.get(cid, '')}")
leak_paths = {k: sorted(v) for k, v in leak_paths.items()}
by_tool = {}
for cid, name in calls.items():
    r = results.get(cid)
    by_tool.setdefault(name, {"calls": 0, "errors": 0, "unanswered": 0})
    by_tool[name]["calls"] += 1
    if r is None: by_tool[name]["unanswered"] += 1
    elif r["isError"]: by_tool[name]["errors"] += 1
ctx_ok = None
if group != "baseline":
    ctx = [results.get(c) for c, n in calls.items() if n == "ctx_search"]
    ctx_ok = bool(ctx) and all(r is not None and not r["isError"] for r in ctx)
turn2_rows = [r for r in rows if r.get("plan") == "probe2"]
positive = {
    "workspace_visible": vis in seen,
    "turn1_rc": int(rc1),
    "turn2_rc": int(rc2),
    "session_resumed": bool(sid) and any(t1 in (r.get("needles") or []) for r in turn2_rows),
    "ctx_tool_ok": ctx_ok,
    "plan_steps_answered": sum(v["calls"] - v["unanswered"] for v in by_tool.values()),
}
evo_pytest = None
for r in results.values():
    if "PROBE-WS-DONE" in r["text"]:
        evo_pytest = "pytest " in r["text"]
positive["evo_pytest_ok"] = evo_pytest
have_docker = os.environ.get("PROBE_HAVE_DOCKER") == "1"
docker_ok = any("PROBE-DOCKER-OK" in r["text"] for r in results.values())
positive["docker_ok"] = docker_ok if have_docker else None
positive["workspace_write_ok"] = any("probe-write" in r["text"] and "PROBE-DOCKER" in r["text"] for r in results.values())
leaked = sorted(k for k, v in leaks.items() if v)
# every host entry activated (an isolation patch that breaks a host plugin, e.g. the permission presets, is a failure)
inactive = []
for t in ("turn-01.log", "turn-02.log"):
    fp = os.path.join(pout, t)
    if os.path.exists(fp):
        lines = open(fp, errors="replace").read().splitlines()
        for i, l in enumerate(lines):
            if "did not activate" in l:
                inactive.append(l.strip()[:200] + (" | " + lines[i + 1].strip()[:200] if i + 1 < len(lines) else ""))
positive["host_entries_ok"] = not inactive
positive["inactive_entries"] = inactive
ok_pos = (positive["workspace_visible"] and positive["turn1_rc"] == 0 and positive["turn2_rc"] == 0 and positive["session_resumed"]
          and (ctx_ok is not False) and positive["workspace_write_ok"] and (positive["docker_ok"] is not False) and positive["host_entries_ok"])
verdict = {"group": group, "isolate": os.environ.get("EVO_ISOLATE", "1"), "requests": len(rows), "leaked": leaked, "leaks": leaks, "leak_paths": leak_paths, "positive": positive, "tools": by_tool,
           "isolated": not leaked, "pass": (not leaked) and ok_pos}
json.dump(verdict, open(os.path.join(pout, "probe.json"), "w"), indent=1)
print(json.dumps({k: verdict[k] for k in ("group", "leaked", "pass")}), json.dumps(positive))
sys.exit(0 if verdict["pass"] else 1)
PY
