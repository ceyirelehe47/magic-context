import copy
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from budget import Ledger, StopRun
from driver import LIVE_BLOCKERS, make_plan, read, score, simulate


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = 0
        self.ledgers = []

    def tearDown(self):
        for ledger in self.ledgers:
            ledger.close()
        self.tmp.cleanup()

    def ledger(self, **overrides):
        kwargs = dict(dollars="10", max_calls=1000, seconds=60, clock=lambda: self.now)
        kwargs.update(overrides)
        ledger = Ledger(Path(self.tmp.name) / f"ledger-{len(self.ledgers)}.jsonl", **kwargs)
        self.ledgers.append(ledger)
        return ledger

    def admit(self, ledger, **overrides):
        kwargs = dict(arm="baseline", kind="main", model="test", input_ceiling=100000,
                      output_ceiling=1000, input_usd_per_million="1",
                      output_usd_per_million="1")
        kwargs.update(overrides)
        return ledger.admit(**kwargs)

    def settle(self, ledger, rid, **overrides):
        kwargs = dict(input_tokens=10, output_tokens=2, provider_usage={"prompt_tokens": 10, "completion_tokens": 2})
        kwargs.update(overrides)
        ledger.settle(rid, **kwargs)

    def test_shared_budget_not_per_arm(self):
        ledger = self.ledger(dollars="0.2")
        self.admit(ledger)
        with self.assertRaises(StopRun):
            self.admit(ledger, arm="plugin")
        self.assertEqual(ledger.snapshot()["calls"], 1)
        self.assertEqual(ledger.charged, Decimal("0.101"))

    def test_every_kind_and_retry_is_counted(self):
        ledger = self.ledger(max_calls=7)
        for kind in ("main", "title", "historian", "native_summary", "dreamer", "embedding", "unknown"):
            rid = self.admit(ledger, kind=kind)
            self.settle(ledger, rid)
        with self.assertRaises(StopRun):
            self.admit(ledger, kind="retry")
        self.assertEqual(ledger.snapshot()["calls"], 7)

    def test_concurrent_atomic_reservations(self):
        ledger = self.ledger(dollars="0.505")
        def attempt(_):
            try:
                return self.admit(ledger)
            except StopRun:
                return None
        with ThreadPoolExecutor(max_workers=12) as pool:
            ids = list(pool.map(attempt, range(12)))
        self.assertEqual(len([i for i in ids if i]), 5)
        self.assertEqual(ledger.charged, Decimal("0.505"))

    def test_unknown_response_retains_reservation_and_halts(self):
        ledger = self.ledger()
        rid = self.admit(ledger)
        with self.assertRaises(StopRun):
            ledger.settle(rid, complete=False)
        self.assertEqual(ledger.charged, Decimal("0.101"))
        with self.assertRaises(StopRun):
            self.admit(ledger)
        self.assertEqual(ledger.snapshot()["unsettled"], 1)

    def test_missing_usage_is_not_zero(self):
        ledger = self.ledger()
        rid = self.admit(ledger)
        with self.assertRaises(StopRun):
            ledger.settle(rid, input_tokens=2, output_tokens=3)
        self.assertEqual(ledger.charged, Decimal("0.101"))

    def test_settlement_releases_only_verified_surplus(self):
        ledger = self.ledger()
        rid = self.admit(ledger)
        self.settle(ledger, rid)
        self.assertEqual(ledger.charged, Decimal("0.000012"))
        with self.assertRaises(ValueError):
            self.settle(ledger, rid)

    def test_elapsed_time_blocks_next_call(self):
        ledger = self.ledger()
        self.now = 60
        with self.assertRaises(StopRun):
            self.admit(ledger)
        self.assertEqual(ledger.snapshot()["calls"], 0)

    def test_provider_ceiling_violation_invalidates_claim(self):
        ledger = self.ledger()
        rid = self.admit(ledger)
        with self.assertRaisesRegex(StopRun, "guarantee invalid"):
            self.settle(ledger, rid, output_tokens=1001)
        self.assertEqual(ledger.charged, Decimal("0.101"))

    def test_invalid_and_unknown_rates_rejected(self):
        for value in ("NaN", "Infinity", "-1", True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.ledger(dollars=value)
        with self.assertRaises(ValueError):
            self.ledger(dollars="10.01")
        ledger = self.ledger()
        for rate in (0, "NaN", -1, True):
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                self.admit(ledger, input_usd_per_million=rate)
        self.assertEqual(ledger.snapshot()["calls"], 0)

    def test_bad_usage_is_not_coerced(self):
        ledger = self.ledger()
        rid = self.admit(ledger)
        with self.assertRaises(StopRun):
            self.settle(ledger, rid, input_tokens=True)

    def test_no_silent_restart(self):
        ledger = self.ledger()
        with self.assertRaises(FileExistsError):
            Ledger(ledger.journal, dollars="10", max_calls=1, seconds=1)

    def test_admission_is_durably_logged(self):
        ledger = self.ledger()
        self.admit(ledger)
        rows = [json.loads(line) for line in ledger.journal.read_text().splitlines()]
        self.assertEqual([r["event"] for r in rows], ["start", "admit"])
        self.assertEqual(rows[1]["reserve_usd"], "0.101000000")

    def test_journal_failure_blocks_dispatch(self):
        ledger = self.ledger()
        ledger.file.close()
        with self.assertRaises(ValueError):
            self.admit(ledger)
        self.assertEqual(len(ledger.records), 0)
        with self.assertRaises(StopRun):
            self.admit(ledger)


class DriverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name) / "plan"
        cls.plan = make_plan(cls.root, bytes_per_file=1024)
        cls.answers = read(cls.root / "verifier" / "answers.json")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def evidence(self, arm="baseline"):
        return simulate(self.plan, self.answers, arm)

    def result(self, evidence):
        return score(self.plan, self.answers, evidence)

    def test_same_completion_and_counterbalanced_pairs(self):
        self.assertEqual(len(self.plan["turns"]), 28)
        self.assertEqual(self.plan["pairs"][0]["order"], ["baseline", "plugin"])
        self.assertEqual(self.plan["pairs"][1]["order"], ["plugin", "baseline"])
        self.assertEqual(len(self.plan["file_hashes"]), 192)

    def test_offline_success_never_means_real_success(self):
        for arm in ("baseline", "plugin"):
            result = self.result(self.evidence(arm))
            self.assertTrue(result["protocol_pass"])
            self.assertFalse(result["real_benchmark_pass"])
            self.assertIsNone(result["cost_usd"])

    def test_fake_live_flag_cannot_bypass_gate(self):
        evidence = self.evidence()
        evidence["origin"] = "live"
        self.assertFalse(self.result(evidence)["protocol_pass"])
        self.assertFalse(self.result(evidence)["real_benchmark_pass"])

    def test_missing_duplicate_reordered_turns_fail(self):
        for mode in ("missing", "duplicate", "reordered"):
            evidence = self.evidence()
            if mode == "missing":
                evidence["turns"].pop()
            elif mode == "duplicate":
                evidence["turns"][2] = copy.deepcopy(evidence["turns"][1])
            else:
                evidence["turns"][1:3] = reversed(evidence["turns"][1:3])
            with self.subTest(mode=mode):
                self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_quality_gate_detects_stale_revision_and_wrong_sum(self):
        for key in ("codeword", "active_units"):
            evidence = self.evidence()
            evidence["turns"][-1]["answer"] = copy.deepcopy(evidence["turns"][-1]["answer"])
            evidence["turns"][-1]["answer"][key] = "WRONG"
            with self.subTest(key=key):
                self.assertFalse(self.result(evidence)["protocol_pass"])
        evidence = self.evidence()
        evidence["turns"][-1]["answer"] = copy.deepcopy(evidence["turns"][-1]["answer"])
        evidence["turns"][-1]["answer"]["inventory"][0]["revision"] -= 1
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_reread_at_checkpoint_is_not_memory_recovery(self):
        evidence = self.evidence()
        evidence["turns"][-1]["tool_calls"].append({"name": "read", "path": "corpus/batch-01-00.txt"})
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_skip_fixture_or_write_notes_is_protocol_failure(self):
        for call in ([], [{"name": "write", "path": "notes.txt"}], [{"name": "bash", "path": "cat corpus/*"}]):
            evidence = self.evidence()
            evidence["turns"][1]["tool_calls"] = call
            self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_plugin_retrieval_allowed_but_not_baseline(self):
        for arm in ("baseline", "plugin"):
            evidence = self.evidence(arm)
            evidence["turns"][-1]["tool_calls"].append({"name": "ctx_expand", "completed": True,
                "turn": evidence["turns"][-1]["turn"], "step": 1, "call_id": "retrieval-1", "seq": 10000, "result_seq": 10001})
            self.assertEqual(self.result(evidence)["protocol_pass"], arm == "plugin")

    def test_failed_read_is_not_completed_work(self):
        evidence = self.evidence()
        evidence["turns"][1]["tool_calls"][0]["completed"] = False
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_missing_result_sequence_is_not_completed_work(self):
        evidence = self.evidence()
        evidence["turns"][1]["tool_calls"][0]["result_seq"] = None
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_batched_reads_in_same_step_are_rejected(self):
        evidence = self.evidence()
        for call in evidence["turns"][1]["tool_calls"]:
            call["step"] = 1
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_next_read_before_previous_result_is_rejected(self):
        evidence = self.evidence()
        calls = evidence["turns"][1]["tool_calls"]
        calls[0]["result_seq"] = calls[1]["seq"] + 1
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_duplicate_call_id_or_result_before_call_is_rejected(self):
        for mutation in ("duplicate", "backwards"):
            evidence = self.evidence()
            calls = evidence["turns"][1]["tool_calls"]
            if mutation == "duplicate":
                calls[1]["call_id"] = calls[0]["call_id"]
            else:
                calls[0]["result_seq"] = calls[0]["seq"] - 1
            self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_process_restart_and_session_identity_required(self):
        for key, value in (("session_id", "another-session"), ("fresh_process", False), ("exit_code", 124)):
            evidence = self.evidence()
            evidence["turns"][5][key] = value
            self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_start_only_error_duplicate_or_no_shrink_is_not_completed(self):
        for update in ({"status": "started"}, {"error": "failed"}, {"after_tokens": 80000}, {"durable_source": None}):
            evidence = self.evidence()
            evidence["reductions"][1].update(update)
            self.assertFalse(self.result(evidence)["protocol_pass"])
        evidence = self.evidence()
        evidence["reductions"][1]["id"] = evidence["reductions"][0]["id"]
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_three_reductions_before_first_probe_do_not_prove_multicycle_recovery(self):
        evidence = self.evidence()
        for reduction in evidence["reductions"]:
            reduction["turn"] = 2
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_metering_missing_unknown_usage_or_request_id_gap_fails(self):
        for change in ("missing", "usage", "id", "unsettled"):
            evidence = self.evidence()
            if change == "missing":
                evidence["metering"]["complete"] = False
            elif change == "usage":
                evidence["requests"][1]["usage"] = None
            elif change == "id":
                evidence["requests"][1]["id"] = 800
            else:
                evidence["requests"][1]["state"] = "reserved"
            self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_corrupt_model_or_head_fails(self):
        for key in ("model", "dsh_version", "source_head"):
            evidence = self.evidence()
            evidence[key] = "wrong"
            self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_mismatched_corpus_is_not_a_paired_result(self):
        evidence = self.evidence()
        evidence["file_hashes"]["batch-01-00.txt"] = "different"
        self.assertFalse(self.result(evidence)["protocol_pass"])

    def test_plan_larger_than_global_call_limit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "1000-attempt cap"):
            make_plan(Path(self.tmp.name) / "oversized", pairs=3)
        self.assertFalse((Path(self.tmp.name) / "oversized").exists())

    def test_corpus_and_answer_files_are_separate(self):
        for name in self.plan["file_hashes"]:
            self.assertTrue((self.root / "corpus" / name).is_file())
        self.assertFalse((self.root / "corpus" / "answers.json").exists())
        self.assertTrue((self.root / "verifier" / "answers.json").is_file())

    def test_refuse_reusing_output_directory(self):
        with self.assertRaises(FileExistsError):
            make_plan(self.root)

    def test_live_cli_exits_before_any_paid_execution(self):
        proc = subprocess.run([sys.executable, str(Path(__file__).with_name("driver.py")), "live"],
                              capture_output=True, text=True, timeout=5)
        self.assertEqual(proc.returncode, 2)
        result = json.loads(proc.stdout)
        self.assertEqual(result["paid_requests_sent"], 0)
        self.assertEqual(result["blockers"], LIVE_BLOCKERS)


if __name__ == "__main__":
    unittest.main()
