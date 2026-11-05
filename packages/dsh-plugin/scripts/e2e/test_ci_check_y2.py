#!/usr/bin/env python3
"""Round 33 P2-A: unit tests for ci-check.py Y2 (scenario Y, restart after
kill -9 during a historian hold).

    python3 packages/dsh-plugin/scripts/e2e/test_ci_check_y2.py

Y2 asks: in y-2 (a NEW process, the killed y-1 holder's lease still
unexpired) the dead lease neither blocks nor is waited out. Until round 32 one
conjunct was "the first step's busy probe reads false". On DSH 0.2.2-alpha.3 /
node 22 (4/4 runs) the probe instead saw ONE lease written 4 ms earlier by the
new process's own first historian pass (owner_pid = the y-2 process, not the
killed pid) — busy because of itself, not because of the dead holder.

Round 33: the probe may read busy only when EVERY lease it saw is provably the
new process's own: owner_pid != the killed pid, holder_id names that same pid,
the lease was written (expires_at - 5 min TTL) after the kill and not after the
probe, and a y-2 historian run was recorded at or after that write. All other
Y2 conjuncts are unchanged (passes noop/success, no lease of the killed pid at
the probe, no live lease and no in-progress flag after the turn, no TTL wait).

Fixtures: fixtures/y2/*.json, trimmed from real dsh-e2e artifacts.
"""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "y2"

_spec = importlib.util.spec_from_file_location("ci_check", HERE / "ci-check.py")
ci_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_check)


def fixture(name):
    return json.loads((FIX / name).read_text())


def judge(b):
    with tempfile.TemporaryDirectory() as d:
        out = Path(d)
        (out / "y-kill.json").write_text(json.dumps(b["y-kill.json"]))
        (out / "y-2-status.jsonl").write_text("\n".join(json.dumps(r) for r in b["y-2-status.jsonl"]) + "\n")
        for k in ("db-y-1k.json", "db-y-2.json"):
            (out / k).write_text(json.dumps(b[k]))
        runs = {n: ("sid", t) for n, t in b["runs"].items()}
        c = ci_check.Checks()
        ci_check.check_y(c, out, runs)
        row = next(r for r in c.rows if r[0] == "Y2")
        return row[1], row[3]


A3 = "alpha3-41859577345-own-fresh-lease.json"
A3B = "alpha3-41842392546-own-fresh-lease.json"
RC5 = "rc5-42034146821-not-busy.json"


def first_lease(b):
    return b["y-2-status.jsonl"][0]["leases"][0]


class Y2(unittest.TestCase):
    def test_rc5_probe_not_busy_passes(self):
        res, detail = judge(fixture(RC5))
        self.assertEqual(res, "PASS", detail)
        self.assertEqual(detail["busyProbe"], "false")

    # RED before round 33: these real alpha.3 runs FAILed Y2
    def test_alpha3_own_fresh_lease_passes(self):
        for name in (A3, A3B):
            res, detail = judge(fixture(name))
            self.assertEqual(res, "PASS", (name, detail))
            self.assertEqual(detail["busyProbe"], "own fresh lease of the new process")

    def test_busy_with_lease_of_killed_pid_fails(self):
        b = fixture(A3)
        L = first_lease(b)
        pid = b["y-kill.json"]["killedPid"]
        L["owner_pid"] = pid
        L["holder_id"] = L["holder_id"].replace(":4933:", f":{pid}:")
        self.assertEqual(judge(b)[0], "FAIL")

    def test_busy_with_lease_written_before_kill_fails(self):
        b = fixture(A3)
        first_lease(b)["expires_at"] = b["y-kill.json"]["at"] + 300000 - 1
        self.assertEqual(judge(b)[0], "FAIL")

    def test_busy_with_holder_pid_mismatch_fails(self):
        b = fixture(A3)
        L = first_lease(b)
        L["holder_id"] = L["holder_id"].replace(":4933:", ":4934:")
        self.assertEqual(judge(b)[0], "FAIL")

    def test_busy_without_a_y2_run_after_the_write_fails(self):
        b = fixture(A3)
        written = first_lease(b)["expires_at"] - 300000
        for r in b["db-y-2.json"]["historianRuns"]:
            if r["created_at"] >= written:
                r["created_at"] = written - 10_000
        self.assertEqual(judge(b)[0], "FAIL")

    def test_busy_with_a_second_unexplained_lease_fails(self):
        b = fixture(A3)
        L = copy.deepcopy(first_lease(b))
        L["owner_pid"] = 1
        L["holder_id"] = L["holder_id"].replace(":4933:", ":1:")
        b["y-2-status.jsonl"][0]["leases"].append(L)
        self.assertEqual(judge(b)[0], "FAIL")

    def test_busy_with_no_lease_listed_fails(self):
        b = fixture(A3)
        b["y-2-status.jsonl"][0]["leases"] = []
        self.assertEqual(judge(b)[0], "FAIL")

    # unchanged conjuncts still bite in the own-lease case
    def test_own_lease_still_live_after_turn_fails(self):
        b = fixture(A3)
        L = copy.deepcopy(first_lease(b))
        L["now"] = L["expires_at"] - 1000
        b["db-y-2.json"]["leases"] = [L]
        self.assertEqual(judge(b)[0], "FAIL")

    def test_failed_pass_fails(self):
        b = fixture(A3)
        b["db-y-2.json"]["historianRuns"][-1]["status"] = "failed"
        self.assertEqual(judge(b)[0], "FAIL")

    def test_ttl_wait_fails(self):
        b = fixture(A3)
        b["runs"]["y-2"] = b["runs"]["y-2"].replace("elapsed=1.5s", "elapsed=301.0s")
        self.assertEqual(judge(b)[0], "FAIL")

    def test_in_progress_left_fails(self):
        b = fixture(A3)
        b["db-y-2.json"]["meta"] = dict(b["db-y-2.json"].get("meta") or {}, compartment_in_progress=1)
        self.assertEqual(judge(b)[0], "FAIL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
