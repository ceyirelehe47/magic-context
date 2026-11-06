#!/usr/bin/env python3
"""Round 36 line I: evo-bench/analyze.py must not count subagent calls as context reductions.

    python3 packages/dsh-plugin/scripts/e2e/test_evo_analyze.py

1M evo bench 42262147533 / 42262946905: DSH `subagent` requests ride the main
route with the main tools, so the proxy files them as kind "main". They
interleave with the main conversation (main 175 153 tokens -> subagent 9 108 ->
main again), and analyze.py reported every switch as a "reduction boundary"
(native run 1: 7, baseline run 1 of 42262946905: 50, native run 2: 27, with
"hit before -> after" means) although no run compacted at all. A request whose
first non-system message starts with a prompt the agent handed to the
`subagent` tool is kind "subagent"; boundaries are computed over "main" only.
Pinned: the subagent call is split out, the main calls around it stay "main",
a main call after a real reduction (different first message, no subagent
prompt) stays "main", the historian / summarizer classification is unchanged,
and a run with packed bodies (bodies.tar.zst) is classified the same way.
"""
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("evo_analyze", HERE / "evo-bench" / "analyze.py")
evo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(evo)

MAIN_SYS = "You are an AI agent powered by DeepSeek Harness. main session"
SUB_PROMPT = "From your knowledge of the public Conan 2.x open-source codebase, explain how backups work."


def usage(p, h):
    return {"prompt_tokens": p, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": h}}


def make_run(root: Path, packed: bool = False) -> Path:
    rd = root / ("packed" if packed else "plain")
    (rd / "bodies").mkdir(parents=True)
    (rd / "resp").mkdir()
    reqs = [
        (1, [{"role": "system", "content": MAIN_SYS}, {"role": "user", "content": "§1§ implement item 1"}], usage(100_000, 99_000)),
        (2, [{"role": "system", "content": "short sub system"}, {"role": "user", "content": SUB_PROMPT + " Be specific."}], usage(9_000, 0)),
        (3, [{"role": "system", "content": MAIN_SYS}, {"role": "user", "content": "§1§ implement item 1"}], usage(101_000, 100_000)),
        # a real reduction: the main conversation restarts from a checkpoint
        (4, [{"role": "system", "content": MAIN_SYS}, {"role": "user", "content": "<session-history>checkpoint</session-history>"}], usage(20_000, 5_000)),
        (5, [{"role": "system", "content": "# Historian\nYou are Historian — the hippocampus"}, {"role": "user", "content": "x"}], usage(30_000, 0)),
        (6, [{"role": "system", "content": MAIN_SYS}, {"role": "user", "content": evo.SUMMARIZER + " now"}], usage(90_000, 80_000)),
    ]
    with open(rd / "requests.jsonl", "w") as f:
        for n, msgs, u in reqs:
            kind = "other" if n == 5 else "main"
            f.write(json.dumps({"n": n, "kind": kind, "status": 200, "nMessages": len(msgs), "usage": u}) + "\n")
            (rd / "bodies" / f"{n}.json").write_text(json.dumps({"model": "m", "messages": msgs, "tools": [{"function": {"name": "bash"}}]}))
    (rd / "resp" / "1.json").write_text(json.dumps({"n": 1, "tool_calls": [{"name": "subagent", "arguments": json.dumps({"description": "Recall", "prompt": SUB_PROMPT})}]}))
    if packed:
        subprocess.run(["tar", "-I", "zstd", "-cf", str(rd / "bodies.tar.zst"), "-C", str(rd), "bodies"], check=True)
        shutil.rmtree(rd / "bodies")
    return rd


class SubagentKinds(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def check(self, rd):
        reqs = evo.jl(str(rd / "requests.jsonl"))
        k = evo.kinds(str(rd), reqs)
        self.assertEqual(k["2"], "subagent")
        self.assertEqual(k["1"], "main")
        self.assertEqual(k["3"], "main")
        self.assertEqual(k["4"], "main")
        self.assertEqual(k["5"], "historian")
        self.assertEqual(k["6"], "summarizer")

    def test_bodies_dir(self):
        self.check(make_run(self.tmp))

    @unittest.skipIf(shutil.which("zstd") is None, "zstd not installed")
    def test_packed_bodies(self):
        self.check(make_run(self.tmp, packed=True))


if __name__ == "__main__":
    unittest.main()
