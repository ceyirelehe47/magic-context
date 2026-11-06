#!/usr/bin/env bash
# Round 36 line I evo bench: ONE run of one group (CompactionBench-style).
#
#   evo-bench/run.sh <baseline|fold|native> <run-label> <out-dir> <task-dir>
#
# Preconditions (dsh-evo-bench.yml): env.sh environment, DSH bootstrapped;
# fold/native: profile "test" with the plugin installed + `setup`; baseline:
# profile "base" (shipped headless template, no plugin); task-dir from
# prepare.py; docker available; OPENCODE_API_KEY set (never printed).
#
# One persistent DSH session per run: request k of requests.json is turn k
# (`dsh --session-id` continues the same session, a fresh process per turn as
# in cache-bench/ci-e2e). The agent works in a copy of the image's /testbed with
# the git history removed; `evo-pytest` runs pytest in a container of the
# instance image with that copy mounted at /testbed. After every turn the tree
# is snapshotted in a git dir OUTSIDE the workspace and the cumulative source
# diff is saved (patches/turn-NN.patch). At the end the last cumulative patch is
# scored by score.py in a fresh container (a separate workflow step). Every model request goes through the
# cache-bench recording proxy (record only; BENCH_ABLATE empty).
#
# Env: EVO_NET_BLOCK (1 = block code hosts / package indexes in /etc/hosts for the run),
# EVO_RUN_TIMEOUT (per turn, s, default 1800; SIGKILL 30 s after SIGTERM), EVO_COST_CAP (USD at
# DeepSeek peak list price; stop starting new turns above it, default 0 = off),
# EVO_DEADLINE (epoch s; stop starting new turns after it), EVO_SANDBOX
# (DSH_PERMISSION_MODE for all groups, default danger-full-access: the agent
# needs docker for evo-pytest, as the paper's agent runs inside the container).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CB="$HERE/../cache-bench"
source "$HERE/../env.sh"
GROUP="$1"; LABEL="$2"; OUT="$(mkdir -p "$3" && cd "$3" && pwd)"; TD="$(cd "$4" && pwd)"
RUN_TIMEOUT="${EVO_RUN_TIMEOUT:-1800}"
case "$GROUP" in
  baseline) PROFILE=base; PATCHES=(--patch "$HERE/evo-model.yml"); unset MAGIC_CONTEXT_DSH_NATIVE_ROLES ;;
  fold) PROFILE=test; PATCHES=(--patch "$HERE/evo-model.yml" --patch "$CB/bench-plugin.yml"); unset MAGIC_CONTEXT_DSH_NATIVE_ROLES ;;
  native) PROFILE=test; PATCHES=(--patch "$HERE/evo-model.yml" --patch "$CB/bench-plugin.yml"); export MAGIC_CONTEXT_DSH_NATIVE_ROLES=1 ;;
  *) echo "group must be baseline|fold|native" >&2; exit 2 ;;
esac
PATCHES+=(--patch "$HERE/bench-evo.yml")
[[ -n "${EVO_BENCH_PATCH:-}" ]] && PATCHES+=(--patch "$EVO_BENCH_PATCH")
export DSH_PERMISSION_MODE="${EVO_SANDBOX:-danger-full-access}"
export BENCH_ABLATE=""
export BENCH_NONCE="$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
export OPENCODE_SESSION="mc-evo-$GROUP-$LABEL-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
export MAGIC_CONTEXT_DEBUG_HISTORIAN=1
# Each turn is its own process: the historian must finish before it exits (as in cache-bench).
export MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS=60000

IMG="$(jq -r .image "$TD/instance.json")"; BASE="$(jq -r .base_commit "$TD/instance.json")"
REPO_NAME="$(jq -r '.repo|split("/")[1]' "$TD/instance.json")"
SCR="${RUNNER_TEMP:-/tmp}/evo/$GROUP-$LABEL"; rm -rf "$SCR"; mkdir -p "$SCR/bin"
WS="$SCR/$REPO_NAME"; SNAP="$SCR/snap.git"; CT="evo-$GROUP-$LABEL-$$"
NT=$(jq length "$TD/requests.json")
printf '{"group":"%s","label":"%s","nonce":"%s","session_header":"%s","profile":"%s","native_roles":"%s","image":"%s","base_commit":"%s","turns_planned":%s,"run_timeout":%s,"cost_cap":"%s","sandbox":"%s","start":%s}\n' \
  "$GROUP" "$LABEL" "$BENCH_NONCE" "$OPENCODE_SESSION" "$PROFILE" "${MAGIC_CONTEXT_DSH_NATIVE_ROLES-}" "$IMG" "$BASE" "$NT" "$RUN_TIMEOUT" "${EVO_COST_CAP:-0}" "$DSH_PERMISSION_MODE" "$(date +%s%3N)" > "$OUT/meta.json"

# --- workspace: the image's /testbed at base_commit, git history and tags removed
docker pull -q "$IMG" >/dev/null
TMPC=$(docker create "$IMG" true)
docker cp "$TMPC:/testbed" "$WS" && docker rm -f "$TMPC" >/dev/null
git -C "$WS" checkout -q -f "$BASE" 2>"$OUT/checkout.err" || { git -C "$WS" fetch -q --depth 1 "https://github.com/$(jq -r .repo "$TD/instance.json")" "$BASE" && git -C "$WS" checkout -q -f "$BASE"; }
HEADC="$(git -C "$WS" rev-parse HEAD)"
[[ "$HEADC" == "$BASE" ]] || { echo "::error::workspace HEAD $HEADC != base $BASE"; exit 1; }
find "$WS" -name .git -prune -exec rm -rf {} +  # repository + submodule git dirs: history, tags, packed future objects
[[ -e "$WS/.git" ]] && { echo "::error::.git still present"; exit 1; }
echo "{\"workspace_head_before_strip\":\"$HEADC\",\"git_removed\":true}" > "$OUT/workspace.json"

snap() { git --git-dir="$SNAP" --work-tree="$WS" "$@"; }
git init -q --bare "$SNAP"
printf '__pycache__/\n*.pyc\n.pytest_cache/\n*.egg-info/\n' > "$SNAP/info/exclude"
snap add -A >/dev/null 2>&1; snap -c user.name=bench -c user.email=bench@local commit -q -m base >/dev/null
BASE_SNAP="$(snap rev-parse HEAD)"

# --- sanitized test image. The instance image's /testbed ships the FULL upstream git history
# (later release tags included): in smoke 42238241963 the fold agent ran
# `docker run IMG git log 2.0.2..2.0.3`, git-showed the upstream commits and applied them.
# The agent needs docker (evo-pytest), so the pristine image must not be on this machine
# during the run: flatten a copy without /testbed (the agent's tree is mounted there) and
# without any .git dir (export | import: no lower layers to dig in), keep the image ENV,
# remove the original (the Score step re-pulls it after the run) and block the registries.
SAN="evo-san-$GROUP-$LABEL:run"
TMPS="evo-san-$$"
docker run --name "$TMPS" --network none --entrypoint bash "$IMG" -c 'rm -rf /testbed && mkdir /testbed && find / -xdev -name .git -prune -exec rm -rf {} + 2>/dev/null; true'
CHG=()
while IFS= read -r ev; do [[ "$ev" == *=* ]] && CHG+=(--change "ENV ${ev%%=*}=\"${ev#*=}\""); done < <(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMG")
docker export "$TMPS" | docker import "${CHG[@]}" --change 'WORKDIR /testbed' - "$SAN" >/dev/null
docker rm -f "$TMPS" >/dev/null
docker rmi -f "$IMG" >/dev/null; docker image prune -f >/dev/null 2>&1
if docker image inspect "$IMG" >/dev/null 2>&1; then echo "::error::pristine image still present"; exit 1; fi
GITS=$(docker run --rm --network none --entrypoint bash "$SAN" -c 'find / -xdev -name .git 2>/dev/null | wc -l')
echo "{\"sanitized_image\":\"$SAN\",\"pristine_removed\":true,\"git_dirs_in_sanitized\":$GITS}" > "$OUT/image.json"
[[ "$GITS" == 0 ]] || { echo "::error::.git left in the sanitized image"; exit 1; }

# --- test container: the agent's tree mounted at /testbed (its editable install path)
docker run -d --network none --name "$CT" -v "$WS:/testbed" "$SAN" sleep infinity >/dev/null
cat > "$SCR/bin/evo-pytest" <<WRAP
#!/usr/bin/env bash
# pytest in the instance image (conda env "testbed"), run in the matching directory under /testbed
rel="\$(python3 -c 'import os,sys; r=os.path.relpath(os.getcwd(), sys.argv[1]); print("" if r=="." or r.startswith("..") else r)' "$WS")"
exec docker exec -i -w "/testbed/\$rel" "$CT" bash -c 'source /opt/miniconda3/bin/activate testbed 2>/dev/null; export PYTHONDONTWRITEBYTECODE=1; exec pytest -p no:cacheprovider "\$@"' evo-pytest "\$@"
WRAP
chmod +x "$SCR/bin/evo-pytest"
export PATH="$SCR/bin:$PATH"
(cd "$WS" && timeout 300 evo-pytest --version > "$OUT/evo-pytest-version.txt" 2>&1); echo "evo-pytest: $(tail -n 2 "$OUT/evo-pytest-version.txt" | tr '\n' ' ')"
grep -q "^pytest " "$OUT/evo-pytest-version.txt" || { echo "::error::evo-pytest does not run in the sanitized image"; exit 1; }

# --- anti-shortcut network block for the run (the model API goes through the proxy to
# opencode.ai, which stays reachable). Exact hostnames only; restored on exit.
BLOCK="github.com api.github.com raw.githubusercontent.com codeload.github.com objects.githubusercontent.com gist.github.com gist.githubusercontent.com pypi.org files.pythonhosted.org pypi.python.org conan.io docs.conan.io center.conan.io datasets-server.huggingface.co huggingface.co cdn-lfs.huggingface.co gitlab.com bitbucket.org registry-1.docker.io auth.docker.io index.docker.io registry.hub.docker.com hub.docker.com docker.io production.cloudflare.docker.com mirror.gcr.io ghcr.io quay.io"
if [[ "${EVO_NET_BLOCK:-1}" == 1 ]]; then
  sudo cp /etc/hosts "$SCR/hosts.orig"
  trap 'sudo cp "$SCR/hosts.orig" /etc/hosts' EXIT
  { echo "# evo-bench block"; for h in $BLOCK; do echo "0.0.0.0 $h"; echo ":: $h"; done; } | sudo tee -a /etc/hosts >/dev/null
  curl -s -m 5 -o /dev/null -w '%{http_code}' https://api.github.com/ > "$OUT/netblock-check.txt" 2>&1; echo " exit=$?" >> "$OUT/netblock-check.txt"
  echo "net block: $(cat "$OUT/netblock-check.txt") (api.github.com, expect 000)"
  timeout 90 docker pull -q "$IMG" > "$OUT/pullblock-check.txt" 2>&1; echo "exit=$?" >> "$OUT/pullblock-check.txt"
  if docker image inspect "$IMG" >/dev/null 2>&1; then echo "::error::pristine image pullable during the run"; exit 1; fi
  echo "pull block: $(tail -n 1 "$OUT/pullblock-check.txt") (expect non-zero)"
fi

node "$CB/proxy.mjs" 18731 "$OUT" > "$OUT/proxy.out" 2>&1 &
PROXY=$!
for _ in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/18731) 2>/dev/null && break; sleep 0.1; done

sid_of() { python3 - "$1" <<'PY'
import json, sys
for line in open(sys.argv[1], errors="replace"):
    try: o = json.loads(line)
    except Exception: continue
    if o.get("type") == "session": print(o.get("sessionId", "")); break
PY
}
cost_now() { python3 "$HERE/analyze.py" --cost "$OUT" 2>/dev/null || echo 0; }

mkdir -p "$OUT/patches"
SID=""; STOP="done"
for k in $(seq 1 "$NT"); do
  if [[ -n "${EVO_DEADLINE:-}" && $(date +%s) -ge $EVO_DEADLINE ]]; then STOP="deadline-before-turn-$k"; break; fi
  if [[ "${EVO_COST_CAP:-0}" != 0 ]] && python3 -c "import sys; sys.exit(0 if float('$(cost_now)') > float('${EVO_COST_CAP}') else 1)"; then STOP="cost-cap-before-turn-$k"; break; fi
  name="turn-$(printf %02d "$k")"
  task="$(jq -r ".[$((k - 1))]" "$TD/requests.json")"
  args=(--profile "$PROFILE" "${PATCHES[@]}" "$task" --json)
  [[ -n "$SID" ]] && args+=(--session-id "$SID")
  s=$(date +%s%3N)
  (cd "$WS" && timeout -k 30 "$RUN_TIMEOUT" node "$DSH_BIN" "${args[@]}" > "$OUT/$name.log" 2>&1)
  rc=$?
  e=$(date +%s%3N)
  [[ -z "$SID" ]] && SID="$(sid_of "$OUT/$name.log")" && echo "$SID" > "$OUT/sid"
  docker exec "$CT" chown -R "$(id -u):$(id -g)" /testbed 2>/dev/null
  snap add -A >/dev/null 2>&1; snap -c user.name=bench -c user.email=bench@local commit -q --allow-empty -m "$name" >/dev/null
  snap diff --binary "$BASE_SNAP" HEAD > "$OUT/patches/$name.patch"
  files=$(snap diff --name-only "$BASE_SNAP" HEAD | wc -l)
  printf '{"turn":%s,"rc":%s,"t0":%s,"t1":%s,"ms":%s,"cum_files":%s,"cum_patch_bytes":%s,"requests":%s}\n' "$k" "$rc" "$s" "$e" "$((e - s))" "$files" "$(stat -c %s "$OUT/patches/$name.patch")" "$(wc -l < "$OUT/requests.jsonl" 2>/dev/null || echo 0)" >> "$OUT/turns.jsonl"
  echo "[evo $GROUP $LABEL] $name rc=$rc $(( (e - s) / 1000 ))s files=$files cost=\$$(cost_now)"
  if [[ -z "$SID" ]]; then STOP="no-session"; break; fi
done
sleep 2; kill "$PROXY" 2>/dev/null; wait "$PROXY" 2>/dev/null
docker rm -f "$CT" >/dev/null 2>&1; docker rmi -f "$SAN" >/dev/null 2>&1
if [[ -n "$SID" ]]; then
  f="$(ls "$DSH_HOME"/sessions/*/"$SID"/session.v4.jsonl.zstd 2>/dev/null | head -n 1)"
  [[ -n "$f" ]] && zstd -qdc "$f" > "$OUT/session.jsonl" 2>/dev/null
fi
python3 - "$OUT/meta.json" "$STOP" <<'PY'
import json, sys, time
m = json.load(open(sys.argv[1])); m["stop"] = sys.argv[2]; m["end"] = int(time.time() * 1000)
json.dump(m, open(sys.argv[1], "w"))
PY
LAST="$(ls "$OUT"/patches/turn-*.patch 2>/dev/null | tail -n 1)"
cp "${LAST:-/dev/null}" "$OUT/final.patch"
# Scoring needs the release's test_patch, which must not sit on the agent's machine during
# the run: the workflow re-fetches the task after this script and runs score.py
# (EVO_SCORE_TASK lets a local caller score here).
[[ -n "${EVO_SCORE_TASK:-}" ]] && python3 "$HERE/score.py" "$EVO_SCORE_TASK" "$OUT/final.patch" "$OUT/score" --label "$GROUP-$LABEL"
echo "[evo $GROUP $LABEL] stop=$STOP requests=$(wc -l < "$OUT/requests.jsonl" 2>/dev/null || echo 0)"
