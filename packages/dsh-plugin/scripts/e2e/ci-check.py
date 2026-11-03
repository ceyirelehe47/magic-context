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
      from it without a retrieval tool
  S*  round 17/18: delegated child reads eight <8 KB files on a 24k route:
      the stock compaction-basic summarizer (not only the pruner) ran in the
      child, Magic wrote no child rows, child finished, result reached the parent
  U*  round 17: ctx_search / ctx_memory / ctx_expand used once each; the
      settings-page readout and /ctx-status agree with the DB; doctor clean
  R*  round 19: native pressure compaction vs MC on an 80k main route —
      R1 no native compaction below 65 % in the MC-led session, R2 MC's
      historian fired first (pct >= 63, threshold 65), R3 the session passed
      the old DSH-default threshold (13 %) without native compaction, R4 the
      pre-round-19 policy (explicit DSH defaults) measured firing < 65 %,
      R5 no "leaving no pressure budget" config error in any run
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
    # C8 the codeword is answered straight from <session-history>, no retrieval tool
    used = [t for t in ("ctx_search", "ctx_expand", "ctx_memory") if tool_calls(out / "cmp-q.log", t)[0]]
    c.add("C8", CODEWORD in ans and not used and (m0.get("mentionsCodeword") is True),
          "codeword answered from <session-history> without ctx_search/ctx_expand", {"toolsUsed": used, "answer": ans[:120]})
    # C9 (f27757b6b) every [dropped §N§] placeholder appears once per tag per
    # event of the decoded main session (round 17: parallel calls doubled them)
    import collections as _co
    dup, placeholders = [], 0
    for e in session_events(out / "cmp-session.jsonl"):
        tags = re.findall(r"\[dropped §(\d+)§\]", json.dumps(e.get("data"), ensure_ascii=False))
        placeholders += len(tags)
        rep = {k: v for k, v in _co.Counter(tags).items() if v > 1}
        if rep:
            dup.append((e.get("seq"), e.get("type"), rep))
    c.add("C9", (out / "cmp-session.jsonl").exists() and not dup,
          "no repeated [dropped §N§] for one tag inside one session event", {"placeholders": placeholders, "dups": dup[:5]})
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
    window, max_tokens = 80000, 4096
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
    c.add("R5", not nobudget, "no TargetPressureConfigError ('leaving no pressure budget') in any run log", nobudget or "clean")


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
