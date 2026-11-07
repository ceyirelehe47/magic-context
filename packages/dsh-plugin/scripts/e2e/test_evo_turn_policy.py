#!/usr/bin/env python3
"""Round 37: the evo bench must not keep feeding a session after a turn timed out, and
must say WHY a run stopped.

    python3 packages/dsh-plugin/scripts/e2e/test_evo_turn_policy.py

Evidence (42274076026 fold @ dc916285b): run.sh appended the next changelog item to the
same DSH session after every `rc=124` turn timeout, so 15 / 15 started turns timed out
while unfinished goals piled up in one session; the run then ended on the workflow
deadline ("deadline-before-turn-16") and the Actions job was green. The earlier fold
runs stopped on the cost cap instead — the stop reasons were mixed up in the notes.

Pinned here:
  * turn_policy.after_turn: rc 0 continues; a timeout (124 from `timeout`, 137 from its
    SIGKILL) stops under the default policy "stop" and continues only under the explicit
    policy "continue" (the turn is then flagged continued-after-timeout); any other
    non-zero rc is a failed turn and stops; a turn without a DSH session is an
    infrastructure failure and always stops.
  * analyze.run_stats classifies the stop (completed / turn-timeout / turn-failed /
    cost-cap / deadline / infra), counts completed (rc 0) vs started vs planned turns,
    reports the on-timeout policy and the continued-after-timeout turns, and counts main
    requests without usage (their tokens and cost are missing from the totals). The
    original score / cost / failed_turns fields keep their meaning.
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name, rel):
    if not (HERE / rel).exists():
        return None
    spec = importlib.util.spec_from_file_location(name, HERE / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


policy = load("evo_turn_policy", "evo-bench/turn_policy.py")
evo = load("evo_analyze_policy", "evo-bench/analyze.py")


def usage(p, h, o=10):
    return {"prompt_tokens": p, "completion_tokens": o, "prompt_tokens_details": {"cached_tokens": h}}


def make_run(root: Path, turns, stop, on_timeout="stop", planned=22, extra_reqs=()):
    rd = root / f"run-{stop}"
    (rd / "bodies").mkdir(parents=True)
    (rd / "resp").mkdir()
    meta = {"group": "fold", "label": "run1", "start": 0, "end": 1000, "turns_planned": planned, "stop": stop, "on_timeout": on_timeout}
    (rd / "meta.json").write_text(json.dumps(meta))
    with open(rd / "turns.jsonl", "w") as f:
        for i, t in enumerate(turns, 1):
            row = {"turn": i, "rc": t if isinstance(t, int) else t[0], "ms": 1000}
            if not isinstance(t, int):
                row["continued_after_timeout"] = True
            f.write(json.dumps(row) + "\n")
    reqs = [
        (1, usage(1000, 900)),
        (2, usage(1100, 1000)),
        (3, None),  # stream cut by the turn timeout: no usage
    ] + list(extra_reqs)
    with open(rd / "requests.jsonl", "w") as f:
        for n, u in reqs:
            row = {"n": n, "kind": "main", "status": 200, "nMessages": 2}
            if u is not None:
                row["usage"] = u
            f.write(json.dumps(row) + "\n")
            (rd / "bodies" / f"{n}.json").write_text(json.dumps({"model": "m", "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]}))
    (rd / "session.jsonl").write_text("")
    return rd


class TurnPolicy(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(policy, "evo-bench/turn_policy.py is missing")

    def test_completed_turn_continues(self):
        self.assertEqual(policy.after_turn(0, "stop", True), ("continue", None))

    def test_timeout_stops_by_default(self):
        for rc in (124, 137):
            self.assertEqual(policy.after_turn(rc, "stop", True, turn=3), ("stop", "turn-timeout-turn-3"))

    def test_timeout_continues_only_when_explicit(self):
        self.assertEqual(policy.after_turn(124, "continue", True, turn=3), ("continue-after-timeout", None))

    def test_failed_turn_stops(self):
        self.assertEqual(policy.after_turn(1, "continue", True, turn=2), ("stop", "turn-failed-rc1-turn-2"))

    def test_no_session_is_infra(self):
        self.assertEqual(policy.after_turn(0, "continue", False, turn=1), ("stop", "infra-no-session-turn-1"))

    def test_unknown_policy_rejected(self):
        with self.assertRaises(ValueError):
            policy.after_turn(124, "maybe", True)

    def test_stop_classes(self):
        cases = {
            "done": "completed",
            "turn-timeout-turn-1": "turn-timeout",
            "turn-failed-rc1-turn-2": "turn-failed",
            "cost-cap-before-turn-12": "cost-cap",
            "deadline-before-turn-16": "deadline",
            "infra-no-session-turn-1": "infra",
            "no-session": "infra",
            None: "unknown",
        }
        for stop, cls in cases.items():
            self.assertEqual(policy.stop_class(stop), cls, stop)


class AnalyzeStops(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_timeout_stop_counts(self):
        rd = make_run(self.root, [0, 0, 124], "turn-timeout-turn-3")
        r = evo.run_stats(str(rd))
        self.assertEqual(r["stop_class"], "turn-timeout")
        self.assertEqual((r["turns_completed"], r["turns_run"], r["turns_planned"]), (2, 3, 22))
        self.assertEqual(r["failed_turns"], [3])  # unchanged meaning
        self.assertEqual(r["on_timeout"], "stop")
        self.assertEqual(r["continued_after_timeout"], [])
        self.assertEqual(r["main_without_usage"], 1)
        self.assertEqual(r["tok_input"], 2100)  # usage-less request is NOT invented into the totals

    def test_continue_mode_is_flagged(self):
        rd = make_run(self.root, [0, (124,), (124,), 0], "deadline-before-turn-5", on_timeout="continue")
        r = evo.run_stats(str(rd))
        self.assertEqual(r["stop_class"], "deadline")
        self.assertEqual(r["turns_completed"], 2)
        self.assertEqual(r["continued_after_timeout"], [2, 3])
        self.assertEqual(r["on_timeout"], "continue")

    def test_legacy_meta_without_policy(self):
        rd = make_run(self.root, [124] * 15, "deadline-before-turn-16")
        meta = json.loads((rd / "meta.json").read_text())
        del meta["on_timeout"]
        (rd / "meta.json").write_text(json.dumps(meta))
        r = evo.run_stats(str(rd))
        # runs before round 37 always appended the next item after a timeout
        self.assertEqual(r["on_timeout"], "continue (pre-round-37 run.sh)")
        self.assertEqual(r["stop_class"], "deadline")
        self.assertEqual(r["turns_completed"], 0)

    def test_cost_cap(self):
        rd = make_run(self.root, [0] * 11, "cost-cap-before-turn-12")
        self.assertEqual(evo.run_stats(str(rd))["stop_class"], "cost-cap")


if __name__ == "__main__":
    unittest.main()
