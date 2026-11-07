#!/usr/bin/env python3
"""Round 37 phase 2 — the isolated DSH process gets an environment ALLOWLIST.

Smoke 42362017411 showed the agent's `env` listing BENCH_OUT (the controller's
output dir) and the GitHub run metadata: launch.sh only unset a fixed blocklist,
so every other controller variable (and any key exported later) reached the DSH
process and every tool it runs. evo_isolation_args must start from an empty
environment (bwrap --clearenv) and set back only what the host needs: PATH, locale,
DSH_*, XDG_*, MAGIC_CONTEXT_*, MC_*, OPENCODE_SESSION/OPENCODE_DB, the mock port /
mock key of the probe, HOME (the agent's private one) and the placeholder API key
(the proxy injects the real one).

Residual boundary (accepted 2026-11-07 18:30 CST): the allowed DSH_* / XDG_* values
name host paths (DSH_HOME, XDG_DATA_HOME); the directories themselves are hidden
from the agent by the bwrap mount namespace and the DSH runner, so the names are
visible but not the contents.
"""
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EVO = os.path.join(HERE, "evo-bench")

CONTROLLER = {
    "BENCH_OUT": "/ctl/bench-out",
    "BENCH_OUT_ROOT": "/ctl/bench-root",
    "BENCH_UPSTREAM_KEY": "sk-not-a-real-key",
    "BENCH_NONCE": "n0nce",
    "GITHUB_SHA": "deadbeef",
    "GITHUB_RUN_ID": "123",
    "GITHUB_WORKSPACE": "/ctl/ws",
    "RUNNER_TEMP": "/ctl/rt",
    "EVO_COST_CAP": "1",
    "EVO_PROBE_CONTROLLER_ENV": "EVOCANARY-env-x",
    "OPENCODE_API_KEY": "sk-real-key-from-secrets",
    "SOME_FUTURE_SECRET": "s3cret",
    "ACTIONS_RUNTIME_TOKEN": "tok",
}
HOST = {
    "DSH_PERMISSION_MODE": "workspace-write",
    "DSH_TELEMETRY_DISABLED": "1",
    "MAGIC_CONTEXT_DSH_NATIVE_ROLES": "0",
    "MAGIC_CONTEXT_DEBUG_HISTORIAN": "1",
    "OPENCODE_SESSION": "mc-evo-x",
    "MOCK_LLM_PORT": "18578",
    "LANG": "C.UTF-8",
}


def isolation_env(tmp):
    root = os.path.join(tmp, "e2e")
    scr = os.path.join(tmp, "scr")
    for d in ["dsh", "home", "xdg/config", "xdg/data", "xdg/state", "xdg/cache"]:
        os.makedirs(os.path.join(root, d), exist_ok=True)
    for d in ["ws", "iso", "home", "bin"]:
        os.makedirs(os.path.join(scr, d), exist_ok=True)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp, "E2E_ROOT": root}
    env.update(CONTROLLER)
    env.update(HOST)
    script = (
        f'source "{HERE}/env.sh"; source "{EVO}/launch.sh"; '
        f'SCR="{scr}"; WS="{scr}/ws"; RG_BINS=(); evo_isolation_args > "{tmp}/args.bin" && env -0 > "{tmp}/env.bin"'
    )
    p = subprocess.run(["bash", "-c", script], env=env, capture_output=True, timeout=60)
    if p.returncode != 0:
        raise AssertionError(p.stderr.decode(errors="replace"))
    with open(os.path.join(tmp, "args.bin"), "rb") as f:
        args = f.read().decode(errors="replace").split("\0")
    if args and args[-1] == "":
        args.pop()
    # the environment the DSH process gets, applied the way bwrap does: the inherited
    # environment of the launching shell, then --clearenv / --setenv / --unsetenv in order
    with open(os.path.join(tmp, "env.bin"), "rb") as f:
        shell_env = f.read().decode(errors="replace").split("\0")
    effective = dict(kv.split("=", 1) for kv in shell_env if "=" in kv)
    sets = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--clearenv":
            effective = {}
        elif a == "--setenv":
            effective[args[i + 1]] = args[i + 2]
            sets[args[i + 1]] = args[i + 2]
            i += 2
        elif a == "--unsetenv":
            effective.pop(args[i + 1], None)
            i += 1
        i += 1
    return args, sets, effective, scr


class IsolationEnv(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.args, self.sets, self.env, self.scr = isolation_env(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_starts_from_an_empty_environment(self):
        self.assertIn("--clearenv", self.args)
        # every --setenv comes after --clearenv (bwrap applies them in order)
        ce = self.args.index("--clearenv")
        first_set = min(i for i, a in enumerate(self.args) if a == "--setenv")
        self.assertLess(ce, first_set)

    def test_controller_variables_never_set(self):
        for k in CONTROLLER:
            if k == "OPENCODE_API_KEY":
                continue
            self.assertNotIn(k, self.env, f"{k} reaches the agent")
        self.assertFalse([k for k in self.env if k.startswith(("GITHUB_", "RUNNER_", "BENCH_", "EVO_", "ACTIONS_"))])
        for v in self.env.values():
            self.assertNotIn("sk-not-a-real-key", v)
            self.assertNotIn("sk-real-key-from-secrets", v)
            self.assertNotIn("EVOCANARY", v)

    def test_api_key_is_the_placeholder(self):
        self.assertEqual(self.env.get("OPENCODE_API_KEY"), "proxy-injects-the-key")

    def test_host_variables_kept(self):
        for k, v in HOST.items():
            self.assertEqual(self.env.get(k), v, k)
        for k in ["PATH", "DSH_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "DSH_BIN"]:
            self.assertIn(k, self.env, k)
        self.assertEqual(self.env.get("HOME"), os.path.join(self.scr, "home"))


if __name__ == "__main__":
    unittest.main()
