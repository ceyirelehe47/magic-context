#!/usr/bin/env python3
"""Prepare/evaluate a task-completion long-run pair. No credentials or HTTP.

`plan` builds identical corpus/prompts for both arms and private verifier data.
`offline` exercises the complete orchestration against a deterministic simulator.
`evaluate` judges evidence, including failure and incomplete runs.
`live` FAILS CLOSED: see LIVE_BLOCKERS. Never pretend simulated evidence is live.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import sys

from dsh_adapter import tool_protocol_errors

SOURCE_HEAD = "87434df011fe351ac8f6353d5cf8aa12f6634d5d"
LIVE_BLOCKERS = [
    "No verified actual OpenCode Go billing tariff, taxes/fees, and hard per-request charge ceiling.",
    "No implemented credential-isolated sole-egress gateway for ALL DSH/plugin/background model calls.",
    "No verified provider ceiling covering hidden reasoning, retries, embeddings and failed requests.",
    "No live DSH evidence adapter proving completed context reductions and post-reduction recovery.",
    "No GitHub Actions incremental-billing ceiling/account-quota verification if Actions is billable.",
]
WORDS = "harbor lantern meadow granite orchard copper thistle saffron glacier willow ember quartz falcon juniper marble cobalt tundra velvet cedar prism".split()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(data):
    return hashlib.sha256(data.encode()).hexdigest()


def make_plan(out, *, seed=137, pairs=2, rounds=24, files_per_round=8, bytes_per_file=7500):
    if not 1 <= pairs <= 3 or not 24 <= rounds <= 48 or rounds % 3:
        raise ValueError("pairs 1..3; rounds 24..48 divisible by 3")
    if not 1 <= files_per_round <= 12 or not 1024 <= bytes_per_file <= 16000:
        raise ValueError("invalid workload size")
    if pairs * 2 * (1 + rounds * (files_per_round + 1) + 3) > 1000:
        raise ValueError("minimum main calls already exceed global 1000-attempt cap")
    out = Path(out)
    # Avoid corrupting an existing run or quietly reusing stale material.
    out.mkdir(parents=True, exist_ok=False)
    states, prompts, expected, file_hashes = {}, [], {}, {}
    codeword = sha(f"codeword:{seed}")[:16].upper()
    invariants = {"release_region": "eu-west", "currency": "USD", "codeword": codeword}
    prompts.append({"turn": 0, "kind": "setup", "prompt":
        "We are maintaining a release inventory. Remember these session rules: "
        + json.dumps(invariants) + ". Source files contain EVENT_JSON records. The highest revision "
        "for an entity replaces its prior record, including cancellation. Read the specified files "
        "one at a time with read. Do not write scratch notes or use shell/web/subagents. "
        "Only read files named in the current turn. Built-in conversation-memory tools may be used. "
        "For every batch return JSON {\"checksums\":{\"filename\":\"checksum\"}}. "
        "At checkpoints return exactly the requested JSON from conversation memory; do not reread files. "
        "Reply now with JSON {\"ready\":true}."})
    expected["0"] = {"ready": True}
    turn = 0
    for batch in range(1, rounds + 1):
        files, checksums = [], {}
        for slot in range(files_per_round):
            idx = (batch - 1) * files_per_round + slot
            entity = f"item-{idx % 12:02d}"
            revision = idx // 12 + 1
            token = sha(f"{seed}:{entity}:{revision}")[:10].upper()
            event = {"id": entity, "revision": revision, "owner": f"team-{(idx * 7) % 5}",
                     "units": 10 + (idx * 13 + seed) % 90,
                     "state": "cancelled" if idx % 11 == 0 else "active", "ticket": token}
            states[entity] = event
            name = f"batch-{batch:02d}-{slot:02d}.txt"
            checksum = sha(json.dumps(event, sort_keys=True))[:12].upper()
            rng, lines = random.Random(seed * 1000 + idx), [f"Evidence {name}"]
            while sum(len(x) + 1 for x in lines) < bytes_per_file - 400:
                lines.append(" ".join(rng.choice(WORDS) for _ in range(15)) + ".")
            # Position changes deterministically; no useful fact is in the filename.
            lines.insert(1 + idx % len(lines), "EVENT_JSON: " + json.dumps(event, sort_keys=True))
            lines.append("CHECKSUM: " + checksum)
            text = "\n".join(lines) + "\n"
            path = out / "corpus" / name
            path.parent.mkdir(exist_ok=True)
            path.write_text(text, encoding="utf-8")
            file_hashes[name] = sha(text)
            files.append(name)
            checksums[name] = checksum
        turn += 1
        prompts.append({"turn": turn, "kind": "batch", "batch": batch, "files": files,
                        "prompt": "Read these files under corpus/ in order, one read call per step: "
                        + ", ".join(files) + ". Apply each EVENT_JSON revision. Return the checksum JSON."})
        expected[str(turn)] = {"checksums": checksums}
        if batch % (rounds // 3) == 0:
            turn += 1
            answer = {**invariants, "inventory": [states[k] for k in sorted(states)],
                      "active_units": sum(v["units"] for v in states.values() if v["state"] == "active")}
            prompts.append({"turn": turn, "kind": "checkpoint", "checkpoint": batch // (rounds // 3),
                            "prompt": "Without reading source files or writing files, reconstruct the latest "
                            "inventory for all 12 items from conversation memory. Return JSON keys "
                            "release_region, currency, codeword, inventory (sorted by id, with id, revision, "
                            "owner, units, state, ticket), active_units (sum units of active items only). "
                            "Cancelled records must remain present. Built-in conversation-memory tools are allowed."})
            expected[str(turn)] = answer
    cases = []
    for p in range(pairs):
        cases.append({"pair": p + 1, "order": ["baseline", "plugin"] if p % 2 == 0 else ["plugin", "baseline"],
                      "seed": seed, "nonce_rule": "independent random per arm; same generation policy"})
    plan = {"schema": 1, "source_head": SOURCE_HEAD, "seed": seed, "pairs": cases,
            "dsh_version": "0.2.1-rc.5", "model": "deepseek-v4.1-flash",
            "main_context_window": 100000, "historian_context_window": 200000,
            "rounds": rounds, "files_per_round": files_per_round, "bytes_per_file": bytes_per_file,
            "minimum_completed_reductions": 3, "required_checkpoints": 3,
            "completion": "all turns and exact quality gates; never stop at first compaction",
            "turns": prompts, "file_hashes": file_hashes,
            "limits": {"total_authorized_usd": "10", "max_upstream_attempts": 1000,
                       "wall_seconds": 7200, "turn_seconds": 300, "consecutive_failed_turns": 1},
            "live_ready": False, "live_blockers": LIVE_BLOCKERS}
    save(out / "plan.json", plan)
    # Do NOT mount verifier/ into the model/DSH filesystem.
    save(out / "verifier" / "answers.json", expected)
    return plan


def json_answer(text):
    if isinstance(text, dict):
        return text
    text = str(text).strip()
    if text.startswith("```json\n") and text.endswith("\n```"):
        text = text[8:-4]
    elif text.startswith("```\n") and text.endswith("\n```"):
        text = text[4:-4]
    return json.loads(text)


def score(plan, answers, evidence):
    """Evidence adapter contract. No heuristics turn missing evidence into success.

    A reduction must include durable source evidence AND lower served context;
    merely starting a historian request, or a compaction/end with an error, does
    not qualify. Live adapter is deliberately not implemented yet.
    """
    issues, turn_results = [], []
    origin = evidence.get("origin")
    if origin not in ("live", "simulated"):
        issues.append("missing evidence origin")
    if evidence.get("source_head") != plan["source_head"]:
        issues.append("source HEAD mismatch")
    if evidence.get("file_hashes") != plan["file_hashes"]:
        issues.append("corpus hash mismatch or unverified corpus")
    if evidence.get("model") != plan["model"] or evidence.get("dsh_version") != plan["dsh_version"]:
        issues.append("model/DSH version mismatch")
    if evidence.get("arm") not in ("baseline", "plugin"):
        issues.append("missing or invalid arm")
    turns = evidence.get("turns", [])
    ids = [t.get("turn") for t in turns]
    if ids != [t["turn"] for t in plan["turns"]]:
        issues.append("missing, duplicate or reordered turns")
    session = evidence.get("session_id")
    if not session:
        issues.append("missing session id")
    for t, want in zip(turns, plan["turns"]):
        ok = t.get("turn") == want["turn"] and t.get("exit_code") == 0 and t.get("session_id") == session
        if t.get("fresh_process") is not True:
            ok = False
        try:
            quality = json_answer(t.get("answer")) == answers[str(want["turn"])]
        except (ValueError, TypeError):
            quality = False
        calls = t.get("tool_calls")
        if not isinstance(calls, list):
            ok = False
            calls = []
        protocol_errors = tool_protocol_errors(calls, expected_turn=want["turn"])
        if protocol_errors:
            ok = False
        actual_reads = []
        for call in calls:
            if not isinstance(call, dict):
                ok = False
                continue
            name = call.get("name", "")
            if name == "read":
                actual_reads.append(call.get("path"))
            elif not (evidence.get("arm") == "plugin" and name in ("ctx_search", "ctx_expand")):
                ok = False
        if want["kind"] == "batch" and actual_reads != ["corpus/" + n for n in want["files"]]:
            ok = False
        if want["kind"] != "batch" and actual_reads:
            ok = False
        # Any scratch writes, extra sources or wrong session invalidate completion.
        turn_results.append({"turn": want["turn"], "kind": want["kind"], "quality": quality,
                             "protocol": ok, "protocol_errors": protocol_errors, "passed": ok and quality})
    reductions = []
    seen = set()
    for red in evidence.get("reductions", []):
        rid = red.get("id")
        valid = (rid and rid not in seen and red.get("status") == "completed"
                 and not red.get("error") and red.get("durable_source")
                 and isinstance(red.get("before_tokens"), int)
                 and isinstance(red.get("after_tokens"), int)
                 and 0 <= red["after_tokens"] < red["before_tokens"])
        if valid:
            reductions.append(red)
            seen.add(rid)
    if len(reductions) < plan["minimum_completed_reductions"]:
        issues.append("insufficient proven completed context reductions")
    # EACH checkpoint must occur after another completed reduction and a restart.
    previous_checkpoint = -1
    for tr in (x for x in turn_results if x["kind"] == "checkpoint"):
        between = [r for r in reductions if isinstance(r.get("turn"), int)
                   and previous_checkpoint < r["turn"] < tr["turn"]]
        if not between:
            issues.append(f"checkpoint {tr['turn']} has no new completed reduction before recovery")
        previous_checkpoint = tr["turn"]
    metering = evidence.get("metering", {})
    requests = evidence.get("requests", [])
    if metering.get("complete") is not True or not requests:
        issues.append("incomplete all-call metering")
    if [r.get("id") for r in requests] != list(range(1, len(requests) + 1)):
        issues.append("missing or duplicate request IDs")
    for r in requests:
        if (not r.get("kind") or r.get("state") != "settled" or
                not isinstance(r.get("usage"), dict) or
                any(isinstance(r.get(k), bool) or not isinstance(r.get(k), int) or r[k] < 0
                    for k in ("input_tokens", "output_tokens"))):
            issues.append("unknown usage, failure or unaccounted request")
            break
    if origin == "live":
        # Deliberately cannot be set true by a manifest/config boolean.
        issues.append("live evidence certification unavailable: sole-egress and billing integration not implemented")
    all_turns = len(turn_results) == len(plan["turns"]) and all(t["passed"] for t in turn_results)
    protocol_pass = all_turns and not issues
    return {"origin": origin, "protocol_pass": protocol_pass,
            "real_benchmark_pass": protocol_pass and origin == "live",
            "quality_passed": sum(t["quality"] for t in turn_results),
            "quality_total": len(plan["turns"]), "completed_reductions": len(reductions),
            "requests": len(requests), "issues": issues, "turns": turn_results,
            "cost_usd": None, "cost_note": "No actual paid execution or verified billing evidence."}


def simulate(plan, answers, arm):
    """Test fixture only. Never reported as a measured DSH result."""
    sid = "simulated-" + arm
    turns, reductions, requests = [], [], []
    event_seq = 0
    for t in plan["turns"]:
        calls = []
        for index, filename in enumerate(t.get("files", []), 1):
            calls.append({"name": "read", "path": "corpus/" + filename,
                          "turn": t["turn"], "step": index,
                          "call_id": f"sim-{t['turn']}-{index}", "completed": True,
                          "seq": event_seq, "result_seq": event_seq + 1})
            event_seq += 2
        turns.append({"turn": t["turn"], "session_id": sid, "fresh_process": True,
                      "exit_code": 0, "answer": answers[str(t["turn"])], "tool_calls": calls})
        kinds = ["main"] * (len(calls) + 1)
        if t["kind"] == "setup":
            kinds.append("title")
        if t["kind"] == "checkpoint":
            reductions.append({"id": "sim-red-" + str(t["turn"]), "turn": t["turn"] - 1,
                               "status": "completed", "durable_source": "SIMULATED",
                               "before_tokens": 80000, "after_tokens": 20000})
            kinds.append("native_summary" if arm == "baseline" else "historian")
        for kind in kinds:
            requests.append({"id": len(requests) + 1, "kind": kind, "state": "settled",
                             "input_tokens": 100, "output_tokens": 10, "usage": {"simulated": True}})
    return {"origin": "simulated", "arm": arm, "source_head": plan["source_head"],
            "file_hashes": dict(plan["file_hashes"]),
            "model": plan["model"], "dsh_version": plan["dsh_version"], "session_id": sid,
            "turns": turns, "reductions": reductions, "requests": requests,
            "metering": {"complete": True}}


def run_offline(out):
    plan = make_plan(out)
    answers = read(Path(out) / "verifier" / "answers.json")
    results = []
    for pair in plan["pairs"]:
        for arm in pair["order"]:
            evidence = simulate(plan, answers, arm)
            result = score(plan, answers, evidence)
            base = Path(out) / f"pair-{pair['pair']}" / arm
            save(base / "evidence.json", evidence)
            save(base / "result.json", result)
            results.append({"pair": pair["pair"], "arm": arm, **result})
    calls = sum(r["requests"] for r in results)
    report = {"kind": "OFFLINE SELF-TEST ONLY", "live_ready": False, "total_simulated_calls": calls,
              "real_benchmark_pass": False, "live_blockers": LIVE_BLOCKERS,
              "offline_pass": all(r["protocol_pass"] for r in results) and calls <= plan["limits"]["max_upstream_attempts"],
              "results": results}
    save(Path(out) / "report.json", report)
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("plan", "offline"):
        sp = sub.add_parser(name)
        sp.add_argument("--out", type=Path, required=True)
    ev = sub.add_parser("evaluate")
    ev.add_argument("--plan", type=Path, required=True)
    ev.add_argument("--answers", type=Path, required=True)
    ev.add_argument("--evidence", type=Path, required=True)
    ev.add_argument("--out", type=Path, required=True)
    sub.add_parser("live", help="fail-closed capability preflight; never sends paid requests")
    args = p.parse_args()
    if args.command == "live":
        print(json.dumps({"live_ready": False, "paid_requests_sent": 0,
                          "authorized_limit_usd": "10", "blockers": LIVE_BLOCKERS}, indent=2))
        return 2
    if args.command == "plan":
        plan = make_plan(args.out)
        print(f"Prepared {len(plan['turns'])} identical turns per arm; live execution is blocked.")
        return 0
    if args.command == "offline":
        report = run_offline(args.out)
        print("OFFLINE SELF-TEST ONLY: " + ("PASS" if report["offline_pass"] else "FAIL"))
        return 0 if report["offline_pass"] else 1
    result = score(read(args.plan), read(args.answers), read(args.evidence))
    save(args.out, result)
    print(json.dumps({k: v for k, v in result.items() if k != "turns"}, indent=2))
    return 0 if result["protocol_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
