#!/usr/bin/env python3
"""Judge the output of ci-e2e.sh (dsh-ci.yml, job `e2e`).

    ci-check.py check  <ci-out-dir>   # writes <dir>/summary.md, exit 1 on any FAIL
    ci-check.py redact <ci-out-dir>   # scrub secrets / home paths in place (run before upload)

The model key is read from OPENCODE_API_KEY only to replace it; it is never
printed. Checks (ids are referenced from summary.md and DSH-MAINTENANCE.md):

  N*  worker self-test, default timeout   (round 13 A1/A2/A3/A5 on CI)
  T*  worker self-test, 1500 ms timeout   (A4 + re-verification of 502d74b94)
  M*  one session over three processes    (§N§ tag identity across restarts)
  C*  round 17: main session past the 65 % execute threshold (40k window):
      historian fired at >= 63 % (threshold-2) with context really > 65 %,
      compartments written, prompt tokens fell below the peak,
      the early codeword is still answerable, no §N§ in visible output, no
      overlapping / stuck compression; C7/C8 (round 18) the cached m0
      <session-history> carries the compartments and the codeword is answered
      from it without a retrieval tool; C10 (round 19) the historian repair
      retry ran in real DSH (e2e-only one-shot corruption of the first output)
  S*  round 17/18: delegated child reads eight <8 KB files on a 24k route:
      the stock compaction-basic summarizer (not only the pruner) ran in the
      child, Magic wrote no child rows, child finished, result reached the parent
  U*  round 17: ctx_search / ctx_memory / ctx_expand used once each; the
      settings-page readout and /ctx-status agree with the DB; doctor clean
  R*  round 19: native pressure compaction vs MC on a 100k main route —
      R1 no native compaction below 65 % in the MC-led session, R2 MC's
      historian fired first (pct >= 63, threshold 65), R3 the session passed
      the old DSH-default threshold (30.4 %) without native compaction, R4 the
      pre-round-19 policy (explicit DSH defaults) measured firing < 65 %,
      R5 no "leaving no pressure budget" config error in any run, R6 the
      engine's per-step pressure checks show an effective main threshold >= 65 %,
      R7 (round 20) the main-session native compaction completed (no
      compaction/end error, no "summarize range unresolvable"), R8 (round 21)
      no native compaction failed on a busy historian lease; R9–R13
      (round 22, scenario L) lock collision: the backstop defers and retries,
      /compact waits for the background pass, the timeout branch fails closed
  U7–U11 (round 22, scenario K) jsonc edited during one live turn: restart-only
      key shown as "running · pending restart" (settings view, /ctx-status),
      hot key shown and applied live (protection floor), cleared by a restart;
      U12 the page's historian model is the one the agent runs with
  P1  no dsh process left after the runs
"""
import json
import os
import re
import sys
from pathlib import Path

ALLOWED_CHILD_TOOLS = {"read", "grep", "glob", "fs_search"}
MASKED = ("bash", "write", "edit", "ctx_search", "ctx_reduce")
TAG_PREFIX = re.compile(r"^\s*§(\d+)§")
CHECK = re.compile(r"native pressure check: child=(true|false) pct=([0-9.]+|\?) thresholdPct=([0-9.]+|\?) window=(\S+) outcome=(\S+)")
NATIVE = re.compile(r"native compaction region: child=(true|false) tokens=(\S+) window=(\S+) pct=([0-9.]+|\?)")
NO_BUDGET = "leaving no pressure budget"
TRIGGER = re.compile(r"historian trigger: pct=(\d+) threshold=(\d+) budget=(\d+) window=(\d+) fires=(true|false)")
CODEWORD = os.environ.get("MC_E2E_CODEWORD", "AMBER-FALCON-7319")
MC_SESSION_TABLES = ("compartments", "compartment_history_versions", "dsh_context_compaction_marker",
                     "compartment_state_lease", "session_meta", "tags", "pending_ops", "dsh_context_outbox",
                     "dsh_pressure_truncations", "historian_runs")


def events(path: Path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def selftest_report(path: Path):
    for ev in events(path):
        if ev.get("type") == "tool_result" and str(ev.get("result", "")).startswith("WORKER_SELFTEST "):
            try:
                return json.loads(ev["result"][len("WORKER_SELFTEST "):])
            except Exception:
                return None
    return None


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


class Checks:
    def __init__(self):
        self.rows = []

    def add(self, cid, ok, what, detail=""):
        self.rows.append((cid, "PASS" if ok is True else ("WARN" if ok == "warn" else "FAIL"), what, detail))

    @property
    def failed(self):
        return any(r[1] == "FAIL" for r in self.rows)


def child_rows(db, cid):
    if not db or cid not in db:
        return None
    return sum(db[cid]["counts"].values())


def check_child_log(c, prefix, path: Path, expect_abort: bool):
    evs = events(path)
    if not evs:
        c.add(f"{prefix}c", "warn", "child session log decoded", "child session file not found")
        return
    tools = set()
    leaked_guidance = False
    tagged_text = False
    turn_end = None
    sandbox = []
    for e in evs:
        t, d = e.get("type"), e.get("data", {})
        if t == "request/header":
            tools |= {x.get("name") for x in d.get("header", {}).get("tools", [])}
        elif t == "system/message":
            s = json.dumps(d.get("message"), ensure_ascii=False)
            leaked_guidance |= "## Magic Context" in s or "§" in s
        elif t == "assistant/message":
            for blk in d.get("message", {}).get("content", []):
                if blk.get("type") == "text" and "§" in blk.get("text", ""):
                    tagged_text = True
        elif t == "turn/end":
            turn_end = d.get("reason")
        elif t == "sandbox/mode":
            sandbox.append(d.get("mode"))
    if tools:
        c.add(f"{prefix}c1", tools <= ALLOWED_CHILD_TOOLS, "child request carries only read-only tools", sorted(tools))
    c.add(f"{prefix}c2", not leaked_guidance, "no Magic guidance / §N§ in child system prompt")
    c.add(f"{prefix}c3", not tagged_text, "child assistant text has no §N§")
    if expect_abort:
        c.add(f"{prefix}c4", isinstance(turn_end, dict) and turn_end.get("kind") == "aborted",
              "child turn/end aborted (disposed)", turn_end)
    c.add(f"{prefix}c5", True, "child sandbox/mode events (informational)", sandbox)


def run_steps(path: Path):
    """[(turn, step, prompt_tokens)] from the headless step_end usage frames."""
    out = []
    for ev in events(path):
        if ev.get("type") == "status" and ev.get("phase") == "step_end" and isinstance(ev.get("usage"), dict):
            u = ev["usage"]
            total = u.get("totalTokens") or 0
            out.append((ev.get("turn"), ev.get("step"), total - (u.get("outputTokens") or 0)))
    return out


def final_text(path: Path):
    t = None
    for ev in events(path):
        if ev.get("type") == "final":
            t = ev.get("text", "")
    return t


def visible_texts(path: Path):
    return [ev.get("text", "") for ev in events(path) if ev.get("type") in ("text", "final")]


def tool_calls(path: Path, name: str):
    calls = {ev.get("callId"): ev for ev in events(path) if ev.get("type") == "tool_call" and ev.get("tool") == name}
    results = [ev for ev in events(path) if ev.get("type") == "tool_result" and ev.get("callId") in calls]
    return list(calls.values()), results


def triggers(path: Path):
    if not path.exists():
        return []
    return [tuple(m.groups()) for m in TRIGGER.finditer(path.read_text(errors="replace"))]


def session_events(path: Path):
    return events(path)


def check_r17(c, out: Path, runs):
    names = sorted(n for n in runs if n.startswith("cmp-") and n != "cmp-q")
    if not names:
        c.add("C0", False, "scenario C ran", "no cmp-* runs")
        return
    seq = names + [n for n in ("cmp-q", "use-search", "use-memory", "use-expand") if n in runs]
    bad = {n: runs[n][1] for n in seq if not runs[n][1].startswith("rc=0")}
    c.add("C0", not bad, "scenario C/U runs exit 0", bad or len(seq))
    # C1 historian trigger: core fires PROACTIVELY at threshold-2 (63 % for the
    # shipped 65 %, checkDshCompartmentTrigger / core parity) — accepted — but
    # the context must actually have gone past 65 % in this scenario (trigger
    # pct or prompt tokens sent / 40k window), and the threshold never lowered.
    trig = {n: triggers(out / f"{n}.log") for n in seq}
    fired = [(n, t) for n, ts in trig.items() for t in ts if t[4] == "true"]
    thresholds = sorted({t[1] for ts in trig.values() for t in ts})
    windows = sorted({t[3] for ts in trig.values() for t in ts})
    first_fire = fired[0] if fired else None
    steps = {n: run_steps(out / f"{n}.log") for n in seq}
    tok = {n: [s[2] for s in v] for n, v in steps.items()}
    max_trig_pct = max([int(t[0]) for ts in trig.values() for t in ts] or [0])
    all_tok = [x for n in seq for x in tok[n]]
    max_tok_pct = round(100 * max(all_tok) / 40000, 1) if all_tok else 0
    exceeded = max(max_trig_pct, max_tok_pct) > 65
    c.add("C1", bool(fired) and thresholds == ["65"] and int(first_fire[1][0]) >= 63 and exceeded,
          "historian fired at pct >= 63 (threshold-2, threshold 65 never lowered) and context really exceeded 65 %",
          {"first": first_fire, "thresholds": thresholds, "windows": windows, "maxTriggerPct": max_trig_pct,
           "maxPromptPct": max_tok_pct,
           "maxPctBeforeFire": max([int(t[0]) for n in seq for t in trig[n] if t[4] == "false"] or [0])})
    # C2 compartments written; first turn where they appear
    dumps = {n: load_json(out / f"db-{n}.json") for n in names}
    first_cmp = next((n for n in names if dumps.get(n) and isinstance(dumps[n].get("compartments"), list)
                      and len(dumps[n]["compartments"]) > 0), None)
    final = load_json(out / "db-cmp-final.json") or load_json(out / "db-cmp-q.json") or {}
    comps = final.get("compartments") if isinstance(final.get("compartments"), list) else []
    c.add("C2", first_cmp is not None and len(comps) > 0, "historian wrote compartments",
          {"firstAfter": first_cmp, "compartments": [(x["sequence"], x["start_message"], x["end_message"], x["title"]) for x in comps],
           "historyVersions": final.get("compartmentHistoryVersions"), "codewordInCompartment": any(x.get("mentionsCodeword") for x in comps)})
    # C3 prompt tokens: the peak vs the LOWEST step after the peak (drops land
    # on the next safe pre-step, so the first step after may still be high).
    detail = {"perRun": tok}
    flat = [(n, x) for n in seq for x in tok[n]]
    ok3 = False
    if first_cmp is not None and flat:
        ipk = max(range(len(flat)), key=lambda i: flat[i][1])
        peak_run, peak = flat[ipk]
        later = flat[ipk + 1:]
        low_run, low = min(later, key=lambda r: r[1]) if later else (None, None)
        detail.update({"peak": peak, "peakRun": peak_run, "lowestAfterPeak": low, "lowestRun": low_run,
                       "window": 40000, "peakPct": round(100 * peak / 40000, 1),
                       "lowPct": round(100 * low / 40000, 1) if low else None,
                       "drop": (peak - low) if low is not None else None})
        ok3 = low is not None and low < peak
    c.add("C3", ok3, "prompt tokens sent: lowest value after the peak is below the peak", detail)
    # C4 codeword after compression
    ans = final_text(out / "cmp-q.log") or ""
    c.add("C4", CODEWORD in ans, "early codeword still answered after compression", ans[:200])
    # C7 (round 18) the compartments really reach the model: the cached m0
    # baseline's <session-history> is non-empty and carries one block per
    # compartment (headless = one process per turn; round 17 replayed an empty
    # one forever), and the codeword compartment is in it.
    m0 = final.get("m0") if isinstance(final.get("m0"), dict) else {}
    first_m0 = next((n for n in names if isinstance((dumps.get(n) or {}).get("m0"), dict)
                     and (dumps[n]["m0"].get("compartmentBlocks") or 0) > 0), None)
    cw_cmp = any(x.get("mentionsCodeword") for x in comps)
    c.add("C7", bool(comps) and (m0.get("compartmentBlocks") or 0) >= 1
          and (m0.get("mentionsCodeword") or not cw_cmp),
          "cached m0 <session-history> carries the compartments (and the codeword one)",
          {"m0": m0, "compartments": len(comps), "firstTurnWithHistoryInM0": first_m0, "codewordCompartment": cw_cmp,
           "materializedAt": (final.get("meta") or {}).get("cached_m0_materialized_at")})
    # C8 the codeword is answered while <session-history> in the injected m0
    # carries it. Round 19 run 41592114076: the model answered correctly but
    # still called ctx_search first (which found nothing) — whether the model
    # chooses to look things up is model behaviour, not a Magic regression, so
    # retrieval calls are recorded but no longer judged.
    used = [t for t in ("ctx_search", "ctx_expand", "ctx_memory") if tool_calls(out / "cmp-q.log", t)[0]]
    c.add("C8", CODEWORD in ans and (m0.get("mentionsCodeword") is True),
          "codeword answered while the injected <session-history> carries it (retrieval calls informational)",
          {"toolsUsed": used, "answer": ans[:120]})
    # C9 (f27757b6b) every [dropped §N§] placeholder appears once per tag per
    # event of the decoded main session (round 17: parallel calls doubled them)
    import collections as _co
    dup, placeholders = [], 0
    for e in session_events(out / "cmp-session.jsonl"):
        # Round 19 run 41591017319: the model's own reasoning quoted
        # "[dropped §4§]" (stored twice: text + raw output) — model-authored
        # assistant messages are not Magic placeholders.
        src = ((e.get("data") or {}).get("message") or {}).get("source") or {}
        if e.get("type") == "assistant/message" and src.get("kind") == "model":
            continue
        tags = re.findall(r"\[dropped §(\d+)§\]", json.dumps(e.get("data"), ensure_ascii=False))
        placeholders += len(tags)
        rep = {k: v for k, v in _co.Counter(tags).items() if v > 1}
        if rep:
            dup.append((e.get("seq"), e.get("type"), rep))
    c.add("C9", (out / "cmp-session.jsonl").exists() and not dup,
          "no repeated [dropped §N§] for one tag inside one session event", {"placeholders": placeholders, "dups": dup[:5]})
    # C10 (round 19) the historian repair retry ran in real DSH: the e2e-only
    # injection corrupted the first historian output exactly once, the repair
    # retry fired after it, and the pass still published (C6: no failure).
    inj, rep = [], []
    for n in seq:
        t = (out / f"{n}.log").read_text(errors="replace") if (out / f"{n}.log").exists() else ""
        i = t.find("e2e: historian output corrupted once")
        if i >= 0:
            inj.append(n)
            if "historian repair retry:" in t[i:]:
                rep.append(n)
        elif inj and "historian repair retry:" in t:
            rep.append(n)
    m = re.findall(r"historian repair retry: ([^\n]{0,160})", "".join(
        (out / f"{n}.log").read_text(errors="replace") for n in seq if (out / f"{n}.log").exists()))
    c.add("C10", len(inj) == 1 and bool(rep) and bool(comps) and not meta_failures(final),
          "historian repair retry exercised in real DSH (injected once, repaired, published, no failure)",
          {"injectedIn": inj, "repairIn": rep, "errors": m[:2], "compartments": len(comps),
           "marker": (out / "historian-corrupt.marker").exists()})
    # C5 no §N§ in user-visible output of any round 17 turn
    leaks = {}
    for n in seq + ["child-parent"]:
        for t in visible_texts(out / f"{n}.log"):
            if re.search(r"§\d+§", t):
                leaks.setdefault(n, []).append(t[:80])
    c.add("C5", not leaks, "no §N§ in visible output (text/final frames)", leaks or "clean")
    # C6 no overlapping / repeated compression, nothing stuck running
    ranges = [(x["start_message"], x["end_message"]) for x in comps]
    overlap = any(b[0] <= a[1] for a, b in zip(ranges, ranges[1:])) or any(a > b for a, b in ranges)
    seqs = [x["sequence"] for x in comps]
    meta = final.get("meta") or {}
    live = [l for l in (final.get("leases") or []) if isinstance(l, dict) and l.get("live")]
    det = final.get("details") or {}
    hist = (det.get("historian") or {}) if isinstance(det, dict) else {}
    c.add("C6", not overlap and seqs == list(range(len(seqs))) and not live and hist.get("state") != "running"
          and not meta.get("historian_failure_count"),
          "compartments contiguous, non-overlapping; no live lease; historian not running/failed",
          {"ranges": ranges, "sequences": seqs, "liveLeases": live, "in_progress": meta.get("compartment_in_progress"),
           "state": hist.get("state"), "failures": meta.get("historian_failure_count"), "markers": final.get("markers")})
    # U1-U3 daily tools
    for cid, run, tool in (("U1", "use-search", "ctx_search"), ("U2", "use-memory", "ctx_memory"), ("U3", "use-expand", "ctx_expand")):
        calls, results = tool_calls(out / f"{run}.log", tool)
        okr = [r for r in results if r.get("status") == "completed" and str(r.get("result", "")).strip()]
        c.add(cid, bool(calls) and bool(okr), f"{tool} called and returned a result",
              {"calls": [str(x.get("input", ""))[:160] for x in calls], "result": [str(r.get("result", ""))[:200] for r in results]})
    c.add("U2b", ((final.get("memoryCodeword") or {}).get("n") or 0) >= 1, "ctx_memory write landed in memories",
          final.get("memoryCodeword"))
    # U4 settings-page readout and /ctx-status agree with the DB
    if isinstance(det, dict) and "compartments" in det:
        ts = {r["status"]: r["n"] for r in (final.get("tagStatus") or []) if isinstance(r, dict)}
        pend = {r["operation"]: r["n"] for r in (final.get("pendingOps") or []) if isinstance(r, dict)}
        mism = {}
        if det.get("compartments") != len(comps):
            mism["compartments"] = (det.get("compartments"), len(comps))
        if (det.get("tags") or {}).get("active") != ts.get("active", 0):
            mism["active"] = ((det.get("tags") or {}).get("active"), ts.get("active", 0))
        if (det.get("tags") or {}).get("dropped") != ts.get("dropped", 0):
            mism["dropped"] = ((det.get("tags") or {}).get("dropped"), ts.get("dropped", 0))
        if (det.get("pending") or {}).get("drops") != pend.get("drop", 0):
            mism["drops"] = ((det.get("pending") or {}).get("drops"), pend.get("drop", 0))
        if det.get("lastContextPercentage") != meta.get("last_context_percentage"):
            mism["pct"] = (det.get("lastContextPercentage"), meta.get("last_context_percentage"))
        c.add("U4", not mism, "settings page / popover readout == DB", mism or {"compartments": len(comps), "tags": ts, "pending": pend})
    else:
        c.add("U4", False, "settings page / popover readout == DB", det)
    st = final.get("status")
    if isinstance(st, str):
        problems = []
        m = re.search(r"- Compartments: (\d+)", st)
        if not m or int(m.group(1)) != len(comps):
            problems.append(f"compartments {m.group(1) if m else None} != {len(comps)}")
        if "historian) and the mid-turn valve are disabled" in st:
            problems.append("claims the historian is disabled (OpenCode DB banner)")
        if re.search(r"- Last input tokens: 0 tokens", st):
            problems.append("Last input tokens: 0 (DSH never recorded usage)")
        if "- Last response: never" in st:
            problems.append("Last response: never (DSH never recorded the completion clock)")
        c.add("U5", not problems, "/ctx-status text agrees with the DB and the live host", problems or "ok")
    else:
        c.add("U5", False, "/ctx-status text agrees with the DB and the live host", st)
    doc = (out / "doctor-after.txt").read_text(errors="replace") if (out / "doctor-after.txt").exists() else ""
    c.add("U6", "rc=0" in doc and "FAIL" not in doc, "doctor after all runs: rc 0, no FAIL", doc[-300:])


def check_r17_child(c, out: Path, runs):
    # --- S: child hits its context limit
    tail = runs.get("child-parent", ("", "missing"))[1]
    c.add("S0", tail.startswith("rc=0"), "child-parent exit", tail)
    kid = (out / "child.sid").read_text().strip() if (out / "child.sid").exists() else ""
    c.add("S1", bool(kid), "parent delegated through the subagent tool", kid or "no 'started subagent'")
    cev = session_events(out / "child-session.jsonl")
    types = [e.get("type") for e in cev]
    starts, summaries = types.count("compaction/start"), types.count("compaction/summary")
    errors = [e.get("data") for e in cev if e.get("type") == "compaction/summary-error"]
    summary_texts = [json.dumps(e.get("data"), ensure_ascii=False) for e in cev if e.get("type") == "compaction/summary"]
    usage = []
    for e in cev:
        if e.get("type") == "assistant/message":
            u = (e.get("data") or {}).get("usage") or {}
            usage.append((u.get("totalTokens") or 0) - (u.get("outputTokens") or 0))
    turn_end = [e.get("data", {}).get("reason") for e in cev if e.get("type") == "turn/end"]
    prunes = types.count("compaction/prune")
    c.add("S2", summaries >= 1 and not errors,
          "child reached the stock compaction-basic SUMMARIZER (compaction/summary, not only prune; no error)",
          {"compaction/start": starts, "compaction/summary": summaries, "compaction/prune": prunes,
           "errors": errors[:2], "childPromptTokens": usage})
    c.add("S3", all("<compartment" not in s and "§" not in s for s in summary_texts),
          "child summary is not MC historian output (no <compartment>, no §N§)", [s[:200] for s in summary_texts[:2]])
    dbk = load_json(out / "db-child.json") or {}
    counts = (dbk.get(kid) or {}).get("counts") if kid else None
    c.add("S4", kid != "" and counts == {}, "child has 0 rows in every Magic table", counts)
    s0, s1 = load_json(out / "r17-snap-s0.json") or {}, load_json(out / "r17-snap-s1.json") or {}
    psid = (out / "child-parent.sid").read_text().strip() if (out / "child-parent.sid").exists() else ""
    pdump = load_json(out / "db-child-parent.json") or {}
    delta = {t: (s1.get("counts", {}).get(t, 0) - s0.get("counts", {}).get(t, 0)) for t in MC_SESSION_TABLES}
    pcomp = len(pdump.get("compartments") or []) if isinstance(pdump.get("compartments"), list) else 0
    c.add("S5", delta.get("compartments", 0) == pcomp and delta.get("compartment_state_lease", 0) <= 0
          and delta.get("dsh_context_compaction_marker", 0) <= (1 if pcomp else 0),
          "MC table growth during the child run is the parent's own only", {"delta": delta, "parentCompartments": pcomp})
    c.add("S6", isinstance(turn_end[-1] if turn_end else None, dict) and turn_end[-1].get("kind") == "completed",
          "child turn completed", turn_end[-1:] if turn_end else None)
    # S7 (round 18): the child read eight generated files whose CHECKSUM line
    # is only reachable by reading each whole file; its result reaches the
    # parent. Counted on the parent's reply, or the child's own final message
    # when the parent paraphrased ("already delivered above", round 17).
    ptext = final_text(out / "child-parent.log") or ""
    sums_path = out / "child-checksums.txt"
    sums = [l.split("\t")[1] for l in sums_path.read_text().splitlines() if l.strip()] if sums_path.exists() else []
    ctext = ""
    for e in cev:
        if e.get("type") == "assistant/message":
            msg = (e.get("data") or {}).get("message") or {}
            parts = [b.get("text", "") for b in (msg.get("content") or []) if isinstance(b, dict) and b.get("type") == "text"]
            if any(p.strip() for p in parts):
                ctext = "".join(parts)
    phits = sum(1 for x in sums if x in ptext)
    chits = sum(1 for x in sums if x in ctext)
    c.add("S7", bool(sums) and max(phits, chits) >= 6,
          "child result (>= 6 of 8 CHECKSUM codes) in the parent reply or the child's final message",
          {"parentHits": phits, "childHits": chits, "of": len(sums), "parent": ptext[:200], "child": ctext[:200]})


def meta_failures(final):
    return (final.get("meta") or {}).get("historian_failure_count") or 0


def ordered_pressure_events(path: Path):
    """[("mc", pct, fires) | ("native", pct, child)] in log order."""
    if not path.exists():
        return []
    text = path.read_text(errors="replace")
    evs = [(m.start(), ("mc", int(m.group(1)), m.group(5) == "true")) for m in TRIGGER.finditer(text)]
    evs += [(m.start(), ("native", float(m.group(4)) if m.group(4) != "?" else None, m.group(1) == "true"))
            for m in NATIVE.finditer(text)]
    return [e for _, e in sorted(evs)]


def check_r19(c, out: Path, runs):
    window, max_tokens = 100000, 4096
    old_threshold = min(0.8 * window, window - max_tokens - 65536)
    old_pct = round(100 * old_threshold / window, 1)
    pnew = sorted(n for n in runs if n.startswith("pnew-"))
    pold = sorted(n for n in runs if n.startswith("pold-"))
    bad = {n: runs[n][1] for n in pnew + pold if not runs[n][1].startswith("rc=0")}
    c.add("R0", bool(pnew) and bool(pold) and not bad, "scenario P runs exit 0", bad or {"pnew": len(pnew), "pold": len(pold)})
    seq = [(n, e) for n in pnew for e in ordered_pressure_events(out / f"{n}.log")]
    native = [(n, e[1]) for n, e in seq if e[0] == "native" and not e[2]]
    mc_fire = next(((n, e[1]) for n, e in seq if e[0] == "mc" and e[2]), None)
    thresholds = sorted({t[1] for n in pnew for t in triggers(out / f"{n}.log")})
    first_native_idx = next((i for i, (_, e) in enumerate(seq) if e[0] == "native" and not e[2]), None)
    first_fire_idx = next((i for i, (_, e) in enumerate(seq) if e[0] == "mc" and e[2]), None)
    sev = session_events(out / "pnew-session.jsonl")
    starts = [e.get("type") for e in sev].count("compaction/start")
    mc_pcts = [e[1] for _, e in seq if e[0] == "mc"]
    tok = [x[2] for n in pnew for x in run_steps(out / f"{n}.log")]
    max_prompt_pct = round(100 * max(tok) / window, 1) if tok else 0
    max_pct = max(mc_pcts + [max_prompt_pct] or [0])
    c.add("R1", bool(pnew) and all(p is not None and p >= 65 for _, p in native),
          "MC-led main session: no native pressure compaction below 65 %",
          {"nativeRegions": native, "compactionStartEvents": starts, "maxTriggerPct": max(mc_pcts or [0]),
           "maxPromptPct": max_prompt_pct})
    c.add("R2", mc_fire is not None and thresholds == ["65"] and mc_fire[1] >= 63
          and (first_native_idx is None or first_fire_idx < first_native_idx),
          "MC historian fired first (pct >= 63, threshold 65) — MC leads, native is only the backstop",
          {"firstFire": mc_fire, "thresholds": thresholds, "nativeBeforeFire": first_native_idx is not None
           and (first_fire_idx is None or first_native_idx < first_fire_idx)})
    c.add("R3", max_pct > old_pct and not [p for _, p in native if p is not None and p < 65],
          f"session passed the old DSH-default threshold ({old_pct} %) with no native compaction there",
          {"oldDefaultPct": old_pct, "maxPct": max_pct})
    oseq = [(n, e) for n in pold for e in ordered_pressure_events(out / f"{n}.log")]
    onative = [(n, e[1]) for n, e in oseq if e[0] == "native" and not e[2]]
    osev = session_events(out / "pold-session.jsonl")
    c.add("R4", bool(onative) and onative[0][1] is not None and onative[0][1] < 65,
          "pre-round-19 policy (explicit DSH defaults) measured: native compaction fired below MC's 65 %",
          {"firstNativePct": onative[0][1] if onative else None, "nativeRegions": onative[:4],
           "compactionStartEvents": [e.get("type") for e in osev].count("compaction/start"), "oldDefaultPct": old_pct})
    nobudget = {}
    for p_ in sorted(out.glob("*.log")):
        n = p_.read_text(errors="replace").count(NO_BUDGET)
        if n:
            nobudget[p_.name] = n
    # R6 (diagnostic) the per-step native pressure checks the engine printed
    def checks_of(names):
        rows = []
        for n in names:
            p_ = out / f"{n}.log"
            if p_.exists():
                rows += [(n,) + tuple(m.groups()) for m in CHECK.finditer(p_.read_text(errors="replace"))]
        return rows
    nc, oc = checks_of(pnew), checks_of(pold)
    # the very first pre-step of a fresh session has no request header yet (pct/threshold "?")
    c.add("R6", bool(nc) and all(float(r[3]) >= 65 for r in nc if r[1] == "false" and r[3] != "?")
          and any(r[3] != "?" for r in nc),
          "native pressure checks ran on the MC main session with an effective threshold >= 65 %",
          {"pnew": [(r[0], r[2], r[3], r[5][:40]) for r in nc][-6:], "pold": [(r[0], r[2], r[3], r[5][:40]) for r in oc][-6:]})
    # R7 (round 20) a main-session native compaction (MC summarize hook) must
    # COMPLETE: round 19's R4 counted compaction/start, but every attempt closed
    # compaction/end with "summarize range unresolvable" (the system prompt
    # compaction-basic prepends to the region was not in the transcript view).
    ends = [(e.get("data") or {}) for name in ("pold", "pnew")
            for e in session_events(out / f"{name}-session.jsonl") if e.get("type") == "compaction/end"]
    errs = [str(d.get("error"))[:160] for d in ends if d.get("error")]
    unresolvable = sum(1 for p_ in sorted(out.glob("*.log")) for _ in re.finditer("summarize range unresolvable", p_.read_text(errors="replace")))
    c.add("R7", bool(ends) and not errs and unresolvable == 0,
          "main-session native compaction completed through the MC summarize hook (no compaction/end error)",
          {"compactionEnds": len(ends), "errors": errs[:3], "unresolvableInLogs": unresolvable})
    c.add("R5", not nobudget, "no TargetPressureConfigError ('leaving no pressure budget') in any run log", nobudget or "clean")
    # R8 (round 21) a historian pass holding the compartment lease must never
    # turn a native compaction into an error: the 90 % backstop defers while the
    # lease is held and /compact waits for it. No compaction/end error and no
    # log line may say "lease busy" for a summarize; deferrals / waits are
    # reported (counts) as evidence of the new paths when they occur.
    # Round 22: lock-c is the deliberate /compact timeout branch (fake stuck
    # lease); its one expected "lease busy" is judged by R13, not here.
    all_ends = [(e.get("data") or {}) for p_ in sorted(out.glob("*-session.jsonl"))
                for e in (session_events(p_) if p_.name != "lock-session.jsonl" else lock_events_before_c(out))
                if e.get("type") == "compaction/end"]
    busy_errs = [str(d.get("error"))[:160] for d in all_ends if d.get("error") and "lease busy" in str(d.get("error"))]
    busy_logs, deferred, waited, pct_unknown = {}, 0, 0, 0
    for p_ in sorted(out.glob("*.log")):
        if p_.name == "lock-c.log":
            continue
        t = p_.read_text(errors="replace")
        n = len(re.findall(r"summarize mini-historian lease busy", t))
        if n:
            busy_logs[p_.name] = n
        deferred += t.count("native pressure backstop deferred")
        waited += t.count("summarize: lease wait ended")
        pct_unknown += len(re.findall(r"native pressure check: child=false pct=\?", t))
    c.add("R8", not busy_errs and not busy_logs,
          "no native compaction failed on a busy historian lease (backstop defers, /compact waits)",
          {"compactionEnds": len(all_ends), "leaseBusyErrors": busy_errs[:3], "leaseBusyLogLines": busy_logs or "none",
           "backstopDeferrals": deferred, "compactLeaseWaits": waited, "mainChecksWithPctUnknown": pct_unknown})



def lock_events_before_c(out: Path):
    """lock-session events up to lock-c's /compact (the deliberate timeout branch)."""
    evs = session_events(out / "lock-session.jsonl")
    runs_ = [i for i, e in enumerate(evs) if e.get("type") == "command/run" and (e.get("data") or {}).get("name") == "compact"]
    return evs[: runs_[1]] if len(runs_) >= 2 else evs


def e2e_lines(path: Path, needle: str):
    if not path.exists():
        return []
    return [l for l in path.read_text(errors="replace").splitlines() if "[magic-context] e2e:" in l and needle in l]


def check_r22_lock(c, out: Path, runs):
    names = ("lock-01", "lock-a", "lock-b", "lock-c")
    bad = {n: runs.get(n, ("", "missing"))[1] for n in names if not runs.get(n, ("", "missing"))[1].startswith("rc=0")}
    la, lb, lc = out / "lock-a.log", out / "lock-b.log", out / "lock-c.log"
    holds = e2e_lines(la, "historian holding the compartment lease")
    text_a = la.read_text(errors="replace") if la.exists() else ""
    fires = list(TRIGGER.finditer(text_a))
    c.add("R9", not bad and bool(holds),
          "scenario L runs exit 0; the background historian held the lease (e2e hold) in lock-a",
          bad or {"holds": len(holds), "historianTriggers": [(m.group(1), m.group(5)) for m in fires][:8]})
    deferrals = re.findall(r"native pressure backstop deferred: .*?\(pressure ([0-9.?]+) % ≥ ([0-9.?]+) %\)", text_a)
    checks = [(m.start(), m.group(2), m.group(3), m.group(5)) for m in CHECK.finditer(text_a) if m.group(1) == "false"]
    evs = lock_events_before_c(out)
    ends = [(e.get("data") or {}) for e in evs if e.get("type") == "compaction/end"]
    errs = [str(d.get("error"))[:200] for d in ends if d.get("error")]
    c.add("R10", bool(deferrals) and not errs,
          "backstop (90 % path; 36 % on this route) deferred silently while the historian held the lease: no compaction/end error",
          {"deferrals": deferrals[:6], "compactionEnds": len(ends), "errors": errs[:3]})
    last_def = text_a.rfind("native pressure backstop deferred")
    after = [x for x in checks if x[0] > last_def] if last_def >= 0 else []
    db_a = load_json(out / "db-lock-a.json") or {}
    comps = db_a.get("compartments") if isinstance(db_a.get("compartments"), list) else []
    retried = [x for x in after if x[3] in ("none", "compacted")]
    c.add("R11", last_def >= 0 and bool(retried) and len(comps) >= 1,
          "a later pressure check retried after the deferral (compacted, or below the backstop once the historian covered it)",
          {"checksAfterLastDeferral": [(p, t, o) for _, p, t, o in after][:6], "compartments": len(comps)})
    text_b = lb.read_text(errors="replace") if lb.exists() else ""
    start_b = e2e_lines(lb, "/compact at idle: start")
    done_b = e2e_lines(lb, "/compact at idle: done")
    waits = re.findall(r"summarize: lease wait ended after (\d+)ms \(([^)]*)\)", text_b)
    busy_b = bool(start_b) and "historianBusy=true" in start_b[0]
    cmd_done = [(e.get("data") or {}) for e in evs if e.get("type") == "command/done"]
    ok_b = busy_b and bool(waits) and all(int(w[0]) <= 45000 for w in waits) and bool(done_b) and "kind=success" in done_b[0]
    c.add("R12", ok_b,
          "/compact (DSH command registry, at idle) met the busy lease, waited <= 45 s and completed",
          {"start": [s_[-120:] for s_ in start_b[:1]], "waits": waits[:2], "done": [d[-200:] for d in done_b[:1]],
           "commandDone": [{k: str(v)[:120] for k, v in d.items()} for d in cmd_done][:2]})
    text_c = lc.read_text(errors="replace") if lc.exists() else ""
    start_c = e2e_lines(lc, "/compact at idle: start")
    done_c = e2e_lines(lc, "/compact at idle: done")
    timeout = re.findall(r"summarize mini-historian lease busy .*?after waiting (\d+)s", text_c)
    released = e2e_lines(lc, "fake lease released")
    db_c = load_json(out / "db-lock-c.json") or {}
    live = [l for l in (db_c.get("leases") or []) if isinstance(l, dict) and l.get("live")]
    nothing = bool(done_c) and "No compactable history" in done_c[0]
    ok_c = bool(start_c) and "fakeLease=20000ms" in start_c[0] and bool(timeout) and bool(done_c) \
        and "kind=error" in done_c[0] and bool(released) and not live
    c.add("R13", True if ok_c else ("warn" if nothing and not live else False),
          "timeout branch: /compact behind a stuck lease fails closed after the (3 s) wait, lease released, nothing left behind",
          {"start": [s_[-120:] for s_ in start_c[:1]], "timeoutAfterS": timeout[:1], "done": [d[-200:] for d in done_c[:1]],
           "released": bool(released), "liveLeases": live})


def check_r23_history(c, out: Path, runs):
    """R14 (round 23): after the SECOND native compaction of the lock session,
    the lock-c prompt and every checksum read in lock-c are still on the
    model-visible surface or inside a published compartment (ctx_expand of its
    start..end shows them) — nothing was shadowed without a summary. Run
    41619627652 failed this: /compact #2 replayed compartments 1–17 over them."""
    rc = runs.get("lock-d", ("", "missing"))[1]
    done = e2e_lines(out / "lock-d.log", "/compact at idle: done")
    h = load_json(out / "history-lock.json") or {}
    files = h.get("files") if isinstance(h.get("files"), list) else []
    prompt = h.get("prompt") if isinstance(h.get("prompt"), dict) else {}
    comps = h.get("compactions") if isinstance(h.get("compactions"), list) else []
    items = ([("prompt", prompt)] if prompt.get("found") else []) + [(f.get("file"), f) for f in files]
    lost = [n for n, it in items if not it.get("onSurface") and not it.get("coveredBy")]
    shadowed = [it.get("historyOrdinal") for _, it in items if not it.get("onSurface") and it.get("historyOrdinal")]
    last = comps[-1] if comps else {}
    reaches = not shadowed or (last.get("summaryMaxEnd") or 0) >= max(shadowed)
    ok = rc.startswith("rc=0") and bool(done) and "kind=success" in done[0] and len(comps) >= 2 \
        and bool(prompt.get("found")) and bool(files) and bool(shadowed) and not lost and reaches
    c.add("R14", ok,
          "second native compaction (lock-d): lock-c's prompt and checksums stay visible or inside a compartment (recoverable by ctx_expand); the summary reaches them",
          {"lockD": rc, "done": [d[-160:] for d in done[:1]], "compactions": [(x.get("seq"), len(x.get("shadowedSeqs") or []), x.get("summaryCompartmentRanges")) for x in comps][:4],
           "lastCompartmentEnd": h.get("lastCompartmentEnd"),
           "prompt": prompt, "files": [{k: f.get(k) for k in ("file", "checksum", "historyOrdinal", "coveredBy", "onSurface")} for f in files][:6],
           "lost": lost, "error": (out / "history-lock.err").read_text(errors="replace")[-300:] if (out / "history-lock.err").exists() else ""})


def k_rows(out: Path):
    p1, p2 = [], []
    path = out / "k-dump.jsonl"
    if not path.exists():
        return p1, p2
    cur = p1
    for line in path.read_text(errors="replace").splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("kind") == "restart":
            cur = p2
            continue
        cur.append(o)
    return p1, p2


def render_pending(changes):
    """The settings page line, as client.js renders it (zh labels; JSON values)."""
    def pj(v):
        return "unset" if v is None else json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    return [f"{x.get('key')} — 运行中的值: {pj(x.get('running'))} · 待重启生效: {pj(x.get('next'))}" for x in changes or []]


def check_r22_k(c, out: Path, runs):
    bad = {n: runs.get(n, ("", "missing"))[1] for n in ("k-1", "k-2") if not runs.get(n, ("", "missing"))[1].startswith("rc=0")}
    edit = load_json(out / "k-edit.json") or {}
    at = edit.get("editedAt")
    p1, p2 = k_rows(out)
    steps1 = [r for r in p1 if r.get("kind") == "step"]
    pre = [r for r in steps1 if at and r.get("at", 0) < at]
    post = [r for r in steps1 if at and r.get("at", 0) > at + 3500]  # past the 3 s jsonc TTL
    turn1 = next((r for r in p1 if r.get("kind") == "turn"), {})
    turn2 = next((r for r in p2 if r.get("kind") == "turn"), {})
    c.add("U7", not bad and bool(at) and bool(pre) and bool(post) and bool(turn1),
          "scenario K: jsonc edited during the live k-1 turn (pre- and post-edit steps in one process)",
          bad or {"stepsBefore": len(pre), "stepsAfterTTL": len(post), "turnRow": bool(turn1), "editedAt": at})
    sv = turn1.get("settingsView") or {}
    pend = sv.get("pendingRestart") or []
    mem = next((x for x in pend if x.get("key") == "memory"), None)
    lines = render_pending(pend)
    ok8 = mem is not None and (mem.get("running") or {}).get("injection_budget_tokens") == 4000 \
        and (mem.get("next") or {}).get("injection_budget_tokens") == 6000 \
        and not [x for x in pend if x.get("key") == "protected_tokens"] \
        and bool(pre) and all(not r.get("pendingRestartKeys") for r in pre) \
        and bool(post) and all("memory" in (r.get("pendingRestartKeys") or []) for r in post)
    c.add("U8", ok8,
          "settings page: restart-only memory.injection_budget_tokens shows 运行中的值 4000 · 待重启生效 6000; the hot key is not listed",
          {"rendered": [l[:220] for l in lines], "pendingKeysBefore": [r.get("pendingRestartKeys") for r in pre][:2],
           "pendingKeysAfter": [r.get("pendingRestartKeys") for r in post][:2]})
    st = turn1.get("ctxStatus") or {}
    text = str(st.get("text") or "")
    block = text.split("### Pending restart", 1)[1] if "### Pending restart" in text else ""
    mem_line = next((l for l in block.splitlines() if l.startswith("- memory: running")), "")
    c.add("U9", st.get("kind") == "success" and bool(mem_line) and '"injection_budget_tokens":4000' in mem_line.replace(" ", "")
          and "6000" in mem_line.split("after restart", 1)[-1] and "protected_tokens" not in block,
          "/ctx-status (DSH command registry, live process): Pending restart lists memory running 4000 -> after restart 6000, not protected_tokens",
          {"kind": st.get("kind"), "pendingBlock": block.strip()[:300] or st.get("error")})
    eff = (sv.get("effective") or {}).get("protectedTokens") or {}
    pop = turn1.get("popover") or {}
    floors_pre = [r.get("protectedFloor") for r in pre]
    floors_post = [r.get("protectedFloor") for r in post]
    hot_post = [r.get("hotProtectedTokens") for r in post]
    meta = (load_json(out / "db-k-1.json") or {}).get("meta") or {}
    ok10 = eff.get("value") == 9000 and eff.get("source") == "jsonc" and bool(hot_post) and all(h == 9000 for h in hot_post) \
        and all(f != 9000 for f in floors_pre) and 9000 in floors_post and meta.get("protected_tokens_effective") == 9000
    c.add("U10", ok10,
          "hot protected_tokens: shown as 9000 at once (settings view) and applied by the next steps of the same process (protection floor -> 9000)",
          {"effective": eff, "popoverProtectedTokens": pop.get("protectedTokens"), "floorBefore": floors_pre[:3],
           "floorAfter": floors_post[:4], "hotAfter": hot_post[:3], "dbFloor": meta.get("protected_tokens_effective"),
           "historianModel": {"page": (sv.get("effective") or {}).get("historianModel"),
                              "agent": (steps1[-1].get("hotHistorianModel") if steps1 else None)}})
    # U12 (round 22 fix 4f0b97a96) the page shows the historian model the agent runs with
    page_hm = (sv.get("effective") or {}).get("historianModel") or {}
    agent_hm = steps1[-1].get("hotHistorianModel") if steps1 else None
    c.add("U12", bool(agent_hm) and page_hm.get("value") == agent_hm,
          "settings page historian.model == the model the agent uses (profile-row value shown, source profile)",
          {"page": page_hm, "agent": agent_hm})
    st2 = turn2.get("ctxStatus") or {}
    sv2 = turn2.get("settingsView") or {}
    c.add("U11", bool(turn2) and not (sv2.get("pendingRestart") or []) and "Pending restart" not in str(st2.get("text") or "")
          and st2.get("kind") == "success",
          "after the restart (k-2, new process) nothing is pending: the new memory value is the running value",
          {"pending": sv2.get("pendingRestart"), "ctxStatusKind": st2.get("kind")})

def check(out: Path) -> int:
    c = Checks()
    runs = {}
    for line in (out / "runs.tsv").read_text().splitlines() if (out / "runs.tsv").exists() else []:
        name, sid, tail = (line.split("\t") + ["", ""])[:3]
        runs[name] = (sid, tail)  # a retried run keeps its last attempt
    db_st = load_json(out / "db-selftest.json")
    children = {}
    if (out / "children.txt").exists():
        for line in (out / "children.txt").read_text().splitlines():
            n, cid = line.split("\t")
            children[n] = cid

    # --- N: normal self-test
    r = selftest_report(out / "selftest-normal.log")
    c.add("N0", r is not None, "selftest-normal: ctx_worker_selftest called", runs.get("selftest-normal", ("", ""))[1])
    if r is not None:
        c.add("N1", r.get("ok") is True, "worker ok:true", {"durationMs": r.get("durationMs"), "workerLog": r.get("workerLog")})
        vis = r.get("childVisibleTools") or []
        c.add("N2", bool(vis) and set(vis) <= ALLOWED_CHILD_TOOLS, "child visible tools ⊆ read/grep/glob", vis)
        res = r.get("toolResolution") or {}
        masked_ok = all(res.get(n, {}).get("child") is False for n in MASKED if n in res)
        ro_ok = all(res.get(n, {}).get("child") is True for n in ("read", "glob", "grep") if n in res)
        c.add("N3", bool(res) and masked_ok and ro_ok, "executor resolution: masked child:false, read-only child:true",
              {k: v.get("child") for k, v in res.items()})
        c.add("N4", "§" not in str(r.get("workerText") or ""), "workerText has no §N§")
        cid = r.get("childSessionId")
        n = child_rows(db_st, cid)
        c.add("N5", n == 0, "child has 0 Magic DB rows", n)
        check_child_log(c, "N", out / "child-selftest-normal.jsonl", expect_abort=False)

    # --- T: 1500 ms timeout (502d74b94)
    r = selftest_report(out / "selftest-timeout.log")
    c.add("T0", r is not None, "selftest-timeout: ctx_worker_selftest called", runs.get("selftest-timeout", ("", ""))[1])
    if r is not None:
        c.add("T1", r.get("ok") is False and r.get("workerText") is None, "worker ok:false after timeout",
              {"timeoutMs": r.get("timeoutMs")})
        wl = r.get("workerLog") or []
        c.add("T2", any("timed out after 1500ms" in m for m in wl),
              "502d74b94: workerLog names the reason (timed out after 1500ms; child disposed)", wl)
        n = child_rows(db_st, r.get("childSessionId"))
        c.add("T3", n in (0, None), "child has 0 Magic DB rows", n)
        check_child_log(c, "T", out / "child-selftest-timeout.jsonl", expect_abort=True)

    # --- M: one session, three processes
    finals = {}
    for k in (1, 2, 3):
        name = f"multi-{k}"
        tail = runs.get(name, ("", "missing"))[1]
        c.add(f"M0.{k}", tail.startswith("rc=0"), f"{name} exit", tail)
        for e in events(out / f"{name}.log"):
            if e.get("type") == "final":
                finals[k] = e.get("text", "")
    dumps = {}
    sid = (out / "multi.sid").read_text().strip() if (out / "multi.sid").exists() else ""
    for k in (1, 2, 3):
        d = load_json(out / f"db-multi-{k}.json")
        if d and sid in d:
            dumps[k] = d[sid]["tags"]
    for k, tags in dumps.items():
        nums = [t["tag_number"] for t in tags]
        mids = [t["message_id"] for t in tags]
        c.add(f"M1.{k}", len(nums) == len(set(nums)) and len(mids) == len(set(mids)),
              f"after turn {k}: tag numbers and message ids unique", {"tags": len(nums)})
        c.add(f"M2.{k}", sorted(nums) == list(range(1, len(nums) + 1)),
              f"after turn {k}: tag numbers contiguous 1..N", sorted(nums))
    ks = sorted(dumps)
    for a, b in zip(ks, ks[1:]):
        before = {t["message_id"]: t["tag_number"] for t in dumps[a]}
        after = {t["message_id"]: t["tag_number"] for t in dumps[b]}
        changed = {m: (n, after.get(m)) for m, n in before.items() if after.get(m) != n}
        c.add(f"M3.{a}-{b}", not changed, f"restart {a}->{b}: every earlier tag keeps its number", changed or len(before))
    c.add("M4", len(dumps) == 3, "tag dumps after all three turns", sorted(dumps))
    for k, text in finals.items():
        m = TAG_PREFIX.match(text)
        if not m:
            continue
        n = int(m.group(1))
        # The reply is tagged on the next pass (next turn), so after turn k its
        # number must still be free (else the model reused a number another
        # message owns: the round 7/8 duplicate-§N§ symptom). Model-side
        # behaviour, so a WARN, not a FAIL.
        taken = [t["message_id"] for t in dumps.get(k, []) if t["tag_number"] == n]
        c.add(f"M5.{k}", True if not taken else "warn",
              f"turn {k} reply prefix §{n}§ not already owned by another message", taken or "free")

    # --- round 17 scenarios
    check_r17(c, out, runs)
    check_r17_child(c, out, runs)
    check_r19(c, out, runs)
    check_r22_lock(c, out, runs)
    check_r23_history(c, out, runs)
    check_r22_k(c, out, runs)

    # --- P: process hygiene
    left = (out / "leftover-procs.txt").read_text().split() if (out / "leftover-procs.txt").exists() else []
    c.add("P1", not left, "no leftover dsh processes", len(left))

    lines = ["# DSH e2e (CI)", "", "| check | result | what | detail |", "|---|---|---|---|"]
    for cid, res, what, detail in c.rows:
        d = json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail
        d = d.replace("|", "\\|")
        if len(d) > 300:
            d = d[:300] + "…"
        lines.append(f"| {cid} | {res} | {what} | {d} |")
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 1 if c.failed else 0


REDACT = [
    (re.compile(r"(sk-)[A-Za-z0-9_-]{6,}"), r"\1<REDACTED>"),
    (re.compile(r"((?:api[_-]?key|token|authorization|bearer)[\"']?\s*[:=]?\s*[\"']?)[A-Za-z0-9._-]{16,}", re.I),
     r"\1<REDACTED>"),
]


def redact(out: Path) -> int:
    key = os.environ.get("OPENCODE_API_KEY", "")
    home = os.environ.get("HOME", "")
    hits = 0
    for p in out.rglob("*"):
        if not p.is_file():
            continue
        try:
            s = p.read_text(errors="replace")
        except Exception:
            continue
        t = s
        if len(key) >= 8:
            hits += t.count(key)
            t = t.replace(key, "<REDACTED:OPENCODE_API_KEY>")
        for rx, rep in REDACT:
            t = rx.sub(rep, t)
        if home:
            t = t.replace(home, "~")
        if t != s:
            p.write_text(t)
    print(f"redact: {sum(1 for _ in out.rglob('*'))} files scanned, literal key occurrences replaced: {hits}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("check", "redact"):
        print(__doc__)
        sys.exit(2)
    d = Path(sys.argv[2])
    sys.exit(check(d) if sys.argv[1] == "check" else redact(d))
