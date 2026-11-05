#!/usr/bin/env python3
"""Round 33 P1-A: unit tests for ci-check.py R14 (check_r23_history).

    python3 packages/dsh-plugin/scripts/e2e/test_ci_check_r14.py

R14 guards the second native compaction of the lock session: lock-c's prompt
and five checksum reads must be recoverable (inside a compartment), the last
summary must reach them, and at least one of them must really have been
folded (non-vacuity guard). Until round 32 "folded" meant "the text is no
longer anywhere on the surface", so a checkpoint that restates a checksum
(run 42034146821: the model stored them with ctx_memory, the historian quoted
them) made the guard fail although the fold happened. Round 33 judges the fold
structurally: a compaction/summary's shadowedSeqs holds the read's raw event
or a node derived from it, and the text is not on the surface outside the
summary nodes' own text.

Fixtures (fixtures/r14/README.md) are ci-history.ts output replayed with the
real DSH Session from three real runs' artifacts; the other cases are
single-field mutations of them.
"""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "r14"

_spec = importlib.util.spec_from_file_location("ci_check", HERE / "ci-check.py")
ci_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_check)

DONE = '[magic-context] e2e: /compact at idle: done kind=success elapsedMs=20046 text="Compacted 15 history items (~14440 tokens)."\n'


def fixture(name):
    return json.loads((FIX / name).read_text())


def judge(history, lock_d_rc="rc=0 elapsed=22.7s", done=DONE):
    with tempfile.TemporaryDirectory() as d:
        out = Path(d)
        (out / "history-lock.json").write_text(json.dumps(history))
        (out / "lock-d.log").write_text(done)
        c = ci_check.Checks()
        ci_check.check_r23_history(c, out, {"lock-d": ("sid", lock_d_rc)})
        rows = [r for r in c.rows if r[0] == "R14"]
        assert len(rows) == 1, rows
        return rows[0][1], rows[0][3]


def items(h):
    return [h["prompt"]] + h["files"]


class R14(unittest.TestCase):
    # 1 — folded, but the checkpoint restates the checksums (run 42034146821)
    def test_1_folded_summary_restates_passes(self):
        h = fixture("rc5-42034146821-summary-restates.json")
        # the real situation: substring still on the surface, only inside the summary
        self.assertTrue(all(it["onSurface"] and it["inSummaryText"] for it in h["files"]))
        self.assertTrue(all(it["shadowedBy"] == [224] and not it["onRawSurface"] for it in items(h)))
        res, detail = judge(h)
        self.assertEqual(res, "PASS", detail)
        self.assertEqual(detail["folded"], [35, 37, 38, 39, 40, 41])

    # 2 — no real fold (session cut before lock-d's /compact): raw copies live
    def test_2_not_folded_fails(self):
        h = fixture("rc5-42034146821-before-lockd-compaction.json")
        self.assertTrue(all(it["shadowedBy"] == [] and it["onRawSurface"] for it in items(h)))
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)
        self.assertEqual(detail["folded"], [])

    # 2b — structurally shadowed, but a raw (non-summary) message still carries the text
    def test_2b_shadowed_but_still_on_raw_surface_is_not_folded(self):
        h = fixture("rc5-42034146821-summary-restates.json")
        for it in items(h):
            it["onRawSurface"] = True
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)
        self.assertEqual(detail["folded"], [])

    # 2c — the text vanished from the raw surface but no compaction folded it
    #       (e.g. only a summary quotes it): not a fold, guard stays unmet
    def test_2c_only_quoted_no_structural_fold_fails(self):
        h = fixture("rc5-42034146821-summary-restates.json")
        for it in items(h):
            it["shadowedBy"] = []
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)

    # 3 — not on the surface and not recoverable from any compartment
    def test_3_lost_fails(self):
        h = fixture("rc5-42034146821-no-compartment-32.json")
        self.assertTrue(all(it["coveredBy"] is None for it in items(h)))
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)
        self.assertEqual(len(detail["lost"]), 6)

    # 3b — one read lost while others are folded fine; a summary that quotes
    #       the lost one's checksum must not rescue it
    def test_3b_one_lost_summary_quote_does_not_rescue(self):
        h = fixture("rc5-42034146821-summary-restates.json")
        h["files"][2]["coveredBy"] = None  # p29, still quoted in the summary text
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)
        self.assertEqual(detail["lost"], ["p29.txt"])

    # 4 — the last summary does not reach the folded reads
    def test_4_summary_does_not_reach_fails(self):
        h = fixture("rc1-42034156577-normal.json")
        h["compactions"][-1]["summaryMaxEnd"] = 36
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)

    # 4b — an item gone from the raw surface without a fold still has to be reached
    def test_4b_gone_unfolded_item_must_be_reached(self):
        h = fixture("rc1-42034156577-normal.json")
        h["files"][-1]["shadowedBy"] = []          # p31 gone, not folded (e.g. dropped)
        h["files"][-1]["historyOrdinal"] = 44     # beyond summaryMaxEnd 42 …
        h["files"][-1]["coveredBy"] = "43-44"     # … though recoverable
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)

    # 5 — normal runs
    def test_5_normal_rc1_passes(self):
        res, detail = judge(fixture("rc1-42034156577-normal.json"))
        self.assertEqual(res, "PASS", detail)

    def test_5_normal_rc5_rerun_passes(self):
        res, detail = judge(fixture("rc5-42037652492-normal.json"))
        self.assertEqual(res, "PASS", detail)

    # unchanged conjuncts
    def test_lock_d_failure_fails(self):
        self.assertEqual(judge(fixture("rc1-42034156577-normal.json"), lock_d_rc="rc=1")[0], "FAIL")
        self.assertEqual(judge(fixture("rc1-42034156577-normal.json"), done="")[0], "FAIL")

    def test_fewer_than_two_compactions_fails(self):
        h = fixture("rc1-42034156577-normal.json")
        h["compactions"] = h["compactions"][-1:]
        self.assertEqual(judge(h)[0], "FAIL")

    def test_prompt_or_files_missing_fails(self):
        h = fixture("rc1-42034156577-normal.json")
        h2 = copy.deepcopy(h)
        h["prompt"]["found"] = False
        h2["files"] = []
        self.assertEqual(judge(h)[0], "FAIL")
        self.assertEqual(judge(h2)[0], "FAIL")

    # a history-lock.json without the structural fields (pre-round-33
    # ci-history.ts) is not judged on the old basis silently
    def test_legacy_json_without_structural_fields_fails(self):
        h = fixture("rc1-42034156577-normal.json")
        for it in items(h):
            for k in ("originSeqs", "shadowedBy", "onRawSurface", "inSummaryText"):
                it.pop(k, None)
        res, detail = judge(h)
        self.assertEqual(res, "FAIL", detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
