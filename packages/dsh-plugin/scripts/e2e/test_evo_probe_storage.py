#!/usr/bin/env python3
"""Round 37 phase 2 — the evo access probe runs on its OWN DSH storage.

The probe (evo-bench/probe.sh) launches the agent's DSH exactly as run.sh does,
but it must not share DSH_HOME (session store, storages) or the Magic Context data
dir (XDG_DATA_HOME, the Magic DB) with the paid run that follows it in the same
job: a probe session / probe compartments / planted canary left in the paid run's
store is residue the paid agent's host would load. launch.sh provides
`evo_probe_storage <nonce>` (fresh DSH_HOME + XDG dirs under E2E_ROOT, which the
isolation hides from the agent; profiles and the plugin config copied, sessions /
storages / DB not) and `evo_probe_storage_cleanup`; probe.sh switches to it
before any launch and removes it at the end.
"""
import os
import re
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EVO = os.path.join(HERE, "evo-bench")


def make_root(tmp):
    root = os.path.join(tmp, "e2e")
    files = {
        "home/profiles/test/node_modules/magic/index.js": "plugin",
        "home/profiles/base/profile.yml": "base",
        "home/sessions/--ws--/S-PAID/session.v4.jsonl.zstd": "paid session",
        "home/storages/mem.json": "paid storage",
        "xdg/data/cortexkit/magic-context/context.db": "paid db",
        "xdg/config/cortexkit/magic-context.jsonc": "{}",
        "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js": "",
    }
    for rel, text in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)
    return root


def run(root, script):
    env = dict(os.environ, E2E_ROOT=root, HOME=os.path.dirname(root))
    env.pop("E2E_XDG_DATA_HOME", None)
    src = f'source "{HERE}/env.sh"; source "{EVO}/launch.sh"; {script}'
    return subprocess.run(["bash", "-c", src], env=env, capture_output=True, text=True, timeout=60)


class ProbeStorage(unittest.TestCase):
    def test_probe_gets_fresh_storage_under_the_hidden_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_root(tmp)
            r = run(root, 'evo_probe_storage abc123 || exit 9; for v in DSH_HOME XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME; do echo "$v=${!v}"; done')
            self.assertEqual(r.returncode, 0, r.stderr)
            env = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
            real = os.path.realpath(root)
            for v in ("DSH_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
                self.assertIn(v, env)
                p = os.path.realpath(env[v])
                # under E2E_ROOT: the isolation hides it from the agent like the paid store
                self.assertTrue(p.startswith(real + os.sep), f"{v}={p} not under {real}")
            self.assertNotEqual(os.path.realpath(env["DSH_HOME"]), os.path.realpath(os.path.join(root, "home")))
            self.assertNotEqual(os.path.realpath(env["XDG_DATA_HOME"]), os.path.realpath(os.path.join(root, "xdg/data")))
            home, data, cfg = env["DSH_HOME"], env["XDG_DATA_HOME"], env["XDG_CONFIG_HOME"]
            # the host still loads the same plugin profiles and config
            self.assertTrue(os.path.isfile(os.path.join(home, "profiles/test/node_modules/magic/index.js")))
            self.assertTrue(os.path.isfile(os.path.join(home, "profiles/base/profile.yml")))
            self.assertTrue(os.path.isfile(os.path.join(cfg, "cortexkit/magic-context.jsonc")))
            # nothing of the paid run's state
            self.assertFalse(os.path.exists(os.path.join(home, "sessions/--ws--/S-PAID")))
            self.assertFalse(os.path.exists(os.path.join(home, "storages/mem.json")))
            self.assertFalse(os.path.exists(os.path.join(data, "cortexkit/magic-context/context.db")))

    def test_probe_writes_leave_the_paid_store_untouched_and_cleanup_removes_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_root(tmp)
            before = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) for f in fs)
            r = run(root, 'evo_probe_storage abc123 || exit 9; mkdir -p "$DSH_HOME/sessions/x/S-PROBE" "$XDG_DATA_HOME/cortexkit/magic-context"; '
                          'echo p > "$DSH_HOME/sessions/x/S-PROBE/s"; echo p > "$XDG_DATA_HOME/cortexkit/magic-context/context.db"; '
                          'evo_probe_storage_cleanup || exit 8; echo done')
            self.assertEqual(r.returncode, 0, r.stderr)
            after = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) for f in fs)
            self.assertEqual(before, after)
            with open(os.path.join(root, "xdg/data/cortexkit/magic-context/context.db")) as f:
                self.assertEqual(f.read(), "paid db")

    def test_probe_sh_switches_storage_before_any_launch_and_cleans_up(self):
        src = open(os.path.join(EVO, "probe.sh")).read()
        code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
        i_store = code.find("evo_probe_storage ")
        self.assertGreater(i_store, 0, "probe.sh does not call evo_probe_storage")
        for later in ("plant sessions", "evo_isolation_setup", "evo_dsh_turn "):
            j = code.find(later)
            self.assertGreater(j, i_store, f"{later} runs before evo_probe_storage")
        self.assertRegex(code, re.compile(r"evo_probe_storage_cleanup"))


if __name__ == "__main__":
    unittest.main()
