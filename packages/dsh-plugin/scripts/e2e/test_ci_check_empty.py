#!/usr/bin/env python3
"""Round 33 (CI audit finding 11): ci-check.py must not PASS a check it had no data for.

    python3 packages/dsh-plugin/scripts/e2e/test_ci_check_empty.py

docs/dsh/e2e/evidence-round33/a-ci-audit.md (#11, a-ci-check-empty-dir.txt): on an
EMPTY CI_OUT, ci-check.py exits 1 with 54 FAIL, but 10 "nothing bad happened"
rows read PASS on no data at all: S3, S5, R5, R8, R10 (scenario P), R15, DN1,
I1, I2, P1. A green row must mean "looked and found nothing bad", never
"found nothing to look at". These tests pin:

  * empty input: every one of those rows is FAIL, and no row at all is PASS;
  * with data and nothing bad in it, each of them still PASSes (no assertion
    was tightened beyond "data must exist");
  * with data that shows the bad thing, the WARN-only rows stay WARN (DN1, I1,
    I2, R10/P) and the FAIL rows stay FAIL (R5, P1) — no WARN became PASS.
"""
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ci_check", HERE / "ci-check.py")
ci_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_check)

VACUOUS = {"S3", "S5", "R5", "R8", "R10", "R15", "DN1", "I1", "I2", "P1"}
R10_P = "scenario P: the model did not call ctx_reduce"


def run_check(d: Path):
    with contextlib.redirect_stdout(io.StringIO()):
        rc = ci_check.check(d)
    return rc, [(cid, res, what) for cid, res, what, _ in _rows(d)]


def _rows(d: Path):
    # re-run through Checks to get the raw rows (summary.md is the same data)
    rows = []
    for line in (d / "summary.md").read_text().splitlines()[4:]:
        parts = [p.strip() for p in line.strip().strip("|").split(" | ")]
        rows.append((parts[0], parts[1], parts[2], parts[3] if len(parts) > 3 else ""))
    return rows


def row(rows, cid, what_prefix=None):
    hits = [r for r in rows if r[0] == cid and (what_prefix is None or r[2].startswith(what_prefix))]
    assert len(hits) == 1, (cid, what_prefix, hits)
    return hits[0][1]


def jl(path: Path, evs):
    path.write_text("".join(json.dumps(e) + "\n" for e in evs))


def clean_data(d: Path):
    """Minimal artifacts in which each of the 10 checks has data and nothing bad."""
    (d / "runs.tsv").write_text("pnew-01\tsid-p\trc=0\npold-01\tsid-o\trc=0\n")
    for n in ("pnew-01", "pold-01"):
        jl(d / f"{n}.log", [{"type": "tool_call", "tool": "read", "callId": "c1", "input": {"path": "/x/a.txt"}},
                            {"type": "text", "text": "reading"}, {"type": "final", "text": "DONE"}])
    jl(d / "child-session.jsonl", [{"type": "compaction/summary", "data": {"text": "plain native summary"}}])
    for k in ("s0", "s1"):
        (d / f"r17-snap-{k}.json").write_text(json.dumps({"counts": {t: 0 for t in ci_check.MC_SESSION_TABLES}}))
    (d / "lock-a.log").write_text(
        "native pressure check: child=false pct=20.0 thresholdPct=36.0 window=40000 outcome=none\n")
    (d / "leftover-procs.txt").write_text("")


class EmptyInput(unittest.TestCase):
    def test_empty_dir_no_row_passes(self):
        with tempfile.TemporaryDirectory() as t:
            rc, rows = run_check(Path(t))
        self.assertEqual(rc, 1)
        passed = sorted({r[0] for r in rows if r[1] == "PASS"})
        self.assertEqual(passed, [], f"rows PASS on an empty CI_OUT: {passed}")

    def test_empty_dir_each_vacuous_row_fails(self):
        with tempfile.TemporaryDirectory() as t:
            _, rows = run_check(Path(t))
        for cid in sorted(VACUOUS - {"R10"}):
            with self.subTest(cid=cid):
                self.assertEqual(row(rows, cid), "FAIL")
        self.assertEqual(row(rows, "R10", R10_P), "FAIL")


class WithData(unittest.TestCase):
    def test_clean_data_passes(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            clean_data(d)
            _, rows = run_check(d)
        for cid in sorted(VACUOUS - {"R10"}):
            with self.subTest(cid=cid):
                self.assertEqual(row(rows, cid), "PASS")
        self.assertEqual(row(rows, "R10", R10_P), "PASS")

    def test_bad_data_keeps_warn_and_fail(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            clean_data(d)
            reads = [{"type": "tool_call", "tool": "read", "callId": f"r{i}", "input": {"path": "/x/b.txt"}} for i in range(4)]
            jl(d / "pnew-01.log", reads + [
                {"type": "text", "text": "<recorded-tool-activity> copied"},
                {"type": "tool_call", "tool": "ctx_reduce", "callId": "d1", "input": {"drop": "1-3"}},
            ])
            # ctx_reduce detection reads the raw line text
            with (d / "pnew-01.log").open("a") as f:
                f.write(json.dumps({"type": "tool_call", "tool": "ctx_reduce", "input": {"drop": "1-3"}}, separators=(",", ":")) + "\n")
            (d / "pold-01.log").write_text("config file must be a top-level array of entries\nleaving no pressure budget\n")
            (d / "leftover-procs.txt").write_text("4242\n")
            _, rows = run_check(d)
        self.assertEqual(row(rows, "DN1"), "WARN")
        self.assertEqual(row(rows, "I1"), "WARN")
        self.assertEqual(row(rows, "I2"), "WARN")
        self.assertEqual(row(rows, "R10", R10_P), "WARN")
        self.assertEqual(row(rows, "R5"), "FAIL")
        self.assertEqual(row(rows, "P1"), "FAIL")


if __name__ == "__main__":
    unittest.main()
