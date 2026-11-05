#!/usr/bin/env python3
"""Round 34 (user decision 2026-11-06 00:09 CST): every ci-check.py row id names ONE check.

    python3 packages/dsh-plugin/scripts/e2e/test_ci_check_ids.py

Round 33 (docs/dsh/e2e/evidence-round33/b-runs.md, notes for the integrator) found ids
used by two different checks; round 34 found the full set the same way:

    T0-T3  scenario T (/compact with <unprocessed_from>)  and  the worker 1500 ms timeout self-test
    R10    scenario P (model's own ctx_reduce, WARN-only)  and  scenario L backstop deferral
    M4     scenario M (legacy migration --restore)         and  one session over three processes

The ids that the maintenance doc and the run tables use for scenario T / P / M keep their id;
the other check moves to an unused id (old -> new table in docs/DSH-MAINTENANCE.md, round 34):

    worker timeout  T0 T1 T2 T3 -> WT0 WT1 WT2 WT3
    lock backstop   R10         -> BS1
    multi-process   M4          -> MP4

Only the id string changes; the judgement of every row is untouched. U4 / U5 / C0 are one
check each on alternative branches (same row, written once per run) and stay as they are.
"""
import contextlib
import importlib.util
import io
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ci_check", HERE / "ci-check.py")
ci_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_check)

RENAMED = {
    "WT0": "selftest-timeout: ctx_worker_selftest called",
    "BS1": "backstop (90 % path",
    "MP4": "tag dumps after all three turns",
}
KEPT = {
    "T0": "scenario T ran",
    "R10": "scenario P: the model did not call ctx_reduce",
    "M0": "scenario M ran",
}


def rows_for(d: Path):
    with contextlib.redirect_stdout(io.StringIO()):
        ci_check.check(d)
    out = []
    for line in (d / "summary.md").read_text().splitlines()[4:]:
        parts = [p.strip() for p in line.strip().strip("|").split(" | ")]
        out.append((parts[0], parts[1], parts[2]))
    return out


class UniqueIds(unittest.TestCase):
    def test_no_id_written_twice_in_one_run(self):
        with tempfile.TemporaryDirectory() as t:
            rows = rows_for(Path(t))
        seen = defaultdict(list)
        for cid, _, what in rows:
            seen[cid].append(what[:60])
        dups = {k: v for k, v in seen.items() if len(v) > 1}
        self.assertEqual(dups, {}, f"ids written by more than one check: {dups}")

    def test_renamed_ids_carry_the_moved_checks(self):
        with tempfile.TemporaryDirectory() as t:
            rows = rows_for(Path(t))
        by_id = {cid: what for cid, _, what in rows}
        for cid, prefix in {**RENAMED, **KEPT}.items():
            if cid not in by_id:
                continue  # early-return branches on an empty CI_OUT; checked statically below
            with self.subTest(cid=cid):
                self.assertTrue(by_id[cid].startswith(prefix), (cid, by_id[cid]))

    def test_source_uses_the_new_ids(self):
        src = (HERE / "ci-check.py").read_text()
        for cid in ("WT0", "WT1", "WT2", "WT3", "BS1", "MP4"):
            with self.subTest(cid=cid):
                self.assertEqual(src.count(f'c.add("{cid}"'), 1, cid)
        for cid in ("T0", "T1", "T2", "T3", "R10", "M4"):
            with self.subTest(cid=cid):
                self.assertEqual(src.count(f'c.add("{cid}"'), 1, cid)


if __name__ == "__main__":
    unittest.main()
