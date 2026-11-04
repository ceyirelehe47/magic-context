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
  W1–W4 (round 25, scenario W, mock) worker child forced to call bash/write: refused (unknown tool), no effect, no leak
  ST1–ST5 (round 25, scenario S, mock) 5 sessions x 4 parallel rounds with restarts: exit 0, no duplicates, no residue, bounded growth
  U26 (round 25, scenario H) every memory under a project identity, no active exact duplicate
  U13–U25 (round 24b, scenario H) multi-session memory CORRECTNESS: four facts
      with codewords pinned in session A, historian >= 2 passes, restarts; the
      message lane returns the fact's own message, ctx_expand the original
      text, the compartment lane answers a paraphrase, an unreachable embedding
      endpoint degrades visibly to full-text; a new session answers paraphrased
      questions (and its injected <project-memory> carries the codes); a
      correction wins over the old value in storage, injection and search; a
      never-recorded fact gets no invented codeword; no cross-session mixing
  T1–T4 (round 26, scenario T; real main model, mock historian route) /compact
      with a historian <unprocessed_from> inside the region: the mini-historian
      left the user constraint uncovered, the summary carries it in an
      <unsummarized_tail> block (original message shadowed, nothing else
      carries the codeword), and the next process obeys the constraint
  M1–M5 (round 26, scenario M) legacy-data migration through the BUILT CLI on
      a legacy fixture DB: scan/dry-run read-only, apply (backup, migrated rows,
      flags), idempotent, restore digest match; a real DSH run injects the
      migrated memory
  E1–E2 (round 26, scenario E, mock main model) exact-identifier ranking on
      scenario H's session A: bag-of-words mock vs a REAL embedding model
      (all-MiniLM-L6-v2); E2 WARN = the ranking issue holds with real vectors
  P1  no dsh process left after the runs
"""
import hashlib
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
    # Round 24 (R10 fix): an over-backstop check that finds no region whose
    # summary could shrink is SKIPPED with a visible line (WARN + /ctx-status
    # record), never silent and never a failed compaction/end. Every main
    # check at/above the backstop must say what it did.
    over = [(p, t, o) for _, p, t, o in checks if p != "?" and t != "?" and float(p) >= float(t)]
    silent = [x for x in over if x[2] not in ("compacted", "deferred:historian-busy", "skipped:would-not-shrink")]
    skipped = [x for x in over if x[2] == "skipped:would-not-shrink"]
    skip_lines = re.findall(r"native pressure backstop skipped: (.*?) — the summary would not shrink", text_a)
    c.add("R15", not silent and len(skip_lines) >= len(skipped) and not errs,
          "every lock-a pressure check at/above the backstop compacted, deferred or was skipped with a visible 'backstop skipped' line (no silent check, no failed compaction/end)",
          {"overBackstop": len(over), "outcomes": sorted({o for _, _, o in over}), "silent": silent[:4],
           "skipped": len(skipped), "skipLines": [l[:160] for l in skip_lines[:3]], "errors": errs[:3]})
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
    # Round 23b: the e2e hold must still be in effect when /compact starts.
    hold_m = re.search(r"holdRemainingMs=(\d+)", start_b[0]) if start_b else None
    busy_b = busy_b and hold_m is not None and int(hold_m.group(1)) > 0
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


X_WINDOW = 24000


def x_requests(out: Path):
    rows = []
    p = out / "x-requests.jsonl"
    if p.exists():
        for line in p.read_text(errors="replace").splitlines():
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows


def check_x(c, out: Path, runs):
    """Round 23b scenario X (mock model enforcing a 24k window with a real BPE
    count; ci-x.sh). X1–X8: no over-window request, truncation of dense / huge
    outputs, historian hold, 90 % backstop, restart, recoverability, no loop."""
    names = ("x-1", "x-2", "x-2r", "x-3", "x-4", "x-5")
    if not any(n in runs for n in names):
        c.add("X0", False, "scenario X ran (mock model)", "no x-* runs")
        return
    reqs = x_requests(out)
    main = [r for r in reqs if r.get("window") == X_WINDOW and r.get("outcome") != "title"]
    over = [r for r in reqs if r.get("outcome") == "context_length_exceeded"]
    by_plan = {}
    for r in main:
        if r.get("plan"):
            by_plan.setdefault(r["plan"], []).append(r)
    dumps = {n: load_json(out / f"db-{n}.json") or {} for n in names}
    rows = {n: {t["tag_number"]: t for t in (dumps[n].get("truncations") or [])} for n in names}
    rc = {n: runs.get(n, ("", "missing"))[1] for n in names}
    def new_rows(a, b):
        return sorted(set(rows[b]) - set(rows[a])) if a else sorted(rows[b])
    def maxp(plan):
        return max((r.get("promptTokens") or 0) for r in by_plan.get(plan, [])) if by_plan.get(plan) else None
    # X1 — one read larger than the whole window
    x1_steps = sorted({r.get("step") for r in by_plan.get("x1", [])})
    c.add("X1", rc["x-1"].startswith("rc=0") and not [r for r in over] and bool(new_rows(None, "x-1"))
          and (maxp("x1") or 0) <= X_WINDOW and 2 in x1_steps,
          "x-1: a 50 KB Chinese read (> the whole 24k window, meter ≈ 12.5k) is truncated before the next request; no request over the window",
          {"rc": rc["x-1"], "truncated": new_rows(None, "x-1"), "maxPrompt": maxp("x1"), "steps": x1_steps,
           "requests": [(r.get("promptTokens"), r.get("maxTokens"), r.get("outcome")) for r in by_plan.get("x1", [])]})
    # X2 — consecutive dense outputs near the limit
    x2_steps = sorted({r.get("step") for r in by_plan.get("x2", [])})
    c.add("X2", rc["x-2"].startswith("rc=0") and (maxp("x2") or 0) <= X_WINDOW and len(new_rows("x-1", "x-2")) >= 1
          and x2_steps == [1, 2, 3, 4, 5],
          "x-2: four 5 000-char Chinese reads in a row — truncated as they accumulate, every request within the window, all steps ran",
          {"rc": rc["x-2"], "truncated": new_rows("x-1", "x-2"), "maxPrompt": maxp("x2"), "steps": x2_steps,
           "prompts": [r.get("promptTokens") for r in by_plan.get("x2", [])]})
    # X3 — big outputs while a historian pass holds the lease
    held = e2e_lines(out / "x-3.log", "historian holding the compartment lease")
    c.add("X3", rc["x-3"].startswith("rc=0") and bool(held) and (maxp("x3") or 0) <= X_WINDOW and len(new_rows("x-2", "x-3")) >= 1,
          "x-3: a 49 KB English and a big Chinese read arrive while the historian holds the lease (e2e hold): truncated anyway, within the window",
          {"rc": rc["x-3"], "holds": len(held), "truncated": new_rows("x-2", "x-3"), "maxPrompt": maxp("x3"),
           "prompts": [r.get("promptTokens") for r in by_plan.get("x3", [])]})
    # X4 — the native 90 % backstop (24k: 82.9 % effective) compacts, no loop
    t4 = (out / "x-4.log").read_text(errors="replace") if (out / "x-4.log").exists() else ""
    compacted = re.findall(r"native pressure check: child=false pct=([0-9.]+) thresholdPct=([0-9.]+) window=24000 outcome=compacted", t4)
    ev4 = events(out / "x-4.log")
    sess = events(out / "x-session.jsonl")
    ends = [(e.get("data") or {}) for e in sess if e.get("type") == "compaction/end"]
    errs = [str(d.get("error"))[:160] for d in ends if d.get("error")]
    # no step compacted twice: compaction/start events between two step/start events
    per_step, cur, loops = [], 0, 0
    for e in sess:
        if e.get("type") == "step/start":
            per_step.append(cur)
            cur = 0
        elif e.get("type") == "compaction/start":
            cur += 1
    per_step.append(cur)
    loops = max(per_step) if per_step else 0
    x4_steps = sorted({r.get("step") for r in by_plan.get("x4", [])})
    clamped = [(r.get("promptTokens"), r.get("maxTokens")) for r in main if (r.get("maxTokens") or 4096) < 256]
    c.add("X4", rc["x-4"].startswith("rc=0") and bool(compacted) and not errs and loops <= 1 and (maxp("x4") or 0) <= X_WINDOW
          and x4_steps[-1:] == [15],
          "x-4: fourteen sub-floor English reads at MC 95 %: the native backstop compacts (no error), at most one compaction per step, all steps ran, within the window",
          {"rc": rc["x-4"], "compacted": compacted[:4], "compactionErrors": errs[:2], "maxCompactionsPerStep": loops,
           "steps": x4_steps, "maxPrompt": maxp("x4"),
           "piAiClampedRequests(info, limitation 17)": clamped[:6]})
    # X5 — restart: no re-decision / duplicate row, dead rows pruned only for dropped tags, outbox settled
    before, after = rows["x-4"], rows["x-5"]
    st5 = {t.get("tag_number"): t.get("status") for t in (dumps["x-5"].get("tags") or [])}
    added = sorted(set(after) - set(before))
    changed = [t for t in after if t in before and after[t] != before[t]]
    removed = sorted(set(before) - set(after))
    bad_prune = [t for t in removed if st5.get(t) not in ("dropped", "compacted")]
    ob = {o.get("status"): o.get("n") for o in (dumps["x-5"].get("outbox") or [])}
    live = [l for l in (dumps["x-5"].get("leases") or []) if (l.get("expires_at") or 0) > (l.get("now") or 0)]
    st2 = {t.get("tag_number"): t.get("status") for t in (dumps["x-2r"].get("tags") or [])}
    live2 = sorted(t for t in rows["x-2"] if st2.get(t) == "active")
    same2 = rows["x-2"] == rows["x-2r"]
    c.add("X5", rc["x-5"].startswith("rc=0") and rc["x-2r"].startswith("rc=0") and same2 and bool(live2)
          and bool(before) and bool(after) and bool(after) and not added and not changed and not bad_prune
          and set(ob) <= {"committed", "superseded", "abandoned"} and not live and (maxp("x5") or 0) <= X_WINDOW,
          "x-2r / x-5 (new processes, same session): truncations of active tags replay unchanged; no truncation re-decided or duplicated (kept rows byte-identical), only rows of dropped tags pruned (latch kept), outbox settled, no live lease",
          {"rc": rc["x-5"], "restartAfterX2": {"rc": rc["x-2r"], "rows": sorted(rows["x-2r"]), "identicalToX2": same2, "activeTruncatedTags": live2},
           "rowsBefore": sorted(before), "rowsAfter": sorted(after), "added": added, "changed": changed,
           "prunedNotDropped": bad_prune, "outbox": ob, "liveLeases": live})
    # X6 — the untruncated original of every truncated tag is still in the session log
    raws = []
    for e in sess:
        if e.get("type") == "tool/result":
            for b in ((e.get("data") or {}).get("message") or {}).get("content") or []:
                if isinstance(b, dict) and isinstance(b.get("text"), str):
                    raws.append(b["text"])
    lost = []
    seen = {}
    for n in names:
        seen.update(rows[n])
    # Hashes taken by ci-x.sh before the redact step ($HOME → "~" changes the
    # text); fall back to hashing the (possibly redacted) log here.
    pre = {}
    try:
        pre = json.loads((out / "x-session-sha.json").read_text())
    except Exception:
        pre = {}
    for tag, r in seen.items():
        want = r.get("original_sha")
        if pre:
            ok = want in (pre.get("raw") or []) or want in ((pre.get("prefixed") or {}).get(str(tag)) or [])
        else:
            ok = any(hashlib.sha256(f"\u00a7{tag}\u00a7 {t}".encode()).hexdigest() == want
                     or hashlib.sha256(t.encode()).hexdigest() == want for t in raws)
        if not ok:
            lost.append(tag)
    c.add("X6", bool(seen) and not lost,
          "every truncated tool result's untruncated original (sha256 in dsh_pressure_truncations) is still in the DSH session log (historian / ctx_expand / re-read source)",
          {"truncated": sorted(seen), "originalMissing": lost, "toolResults": len(raws), "hashedBeforeRedact": bool(pre)})
    # X7 — never an over-window request in the whole scenario
    c.add("X7", bool(main) and not over,
          "scenario X: the mock (real BPE count, 24k enforced) never received a request over the window",
          {"requests": len(reqs), "overWindow": [(r.get("n"), r.get("promptTokens")) for r in over][:5],
           "maxPrompt": max((r.get("promptTokens") or 0) for r in main) if main else None})
    # X8 — no request storm: each plan step was requested at most 3 times
    repeats = {}
    for r in main:
        if r.get("plan") and r.get("step"):
            k = f"{r['plan']}:{r['step']}"
            repeats[k] = repeats.get(k, 0) + 1
    worst = max(repeats.values()) if repeats else 0
    c.add("X8", bool(repeats) and worst <= 3,
          "no loop: no plan step was requested more than 3 times (a retry storm or a compaction loop would repeat it)",
          {"maxRepeats": worst, "repeated": {k: v for k, v in repeats.items() if v > 1}})


def check_y(c, out: Path, runs):
    """Round 23c scenario Y (ci-x.sh): kill -9 the DSH process while a
    background historian pass holds the compartment lease, then continue the
    same session in two new processes. Y1–Y6."""
    names = ("y-1", "y-2", "y-3")
    if not any(n in runs for n in names):
        c.add("Y0", False, "scenario Y ran (kill -9 during a historian hold)", "no y-* runs")
        return
    kill = load_json(out / "y-kill.json") or {}
    d = {n: load_json(out / f"db-{n}.json") or {} for n in ("y-1k", "y-2", "y-3", "x-5", "x-after-y")}
    rc = {n: runs.get(n, ("", "missing"))[1] for n in names}
    pid = kill.get("killedPid")
    # Y1 — the kill landed inside the hold: the dead process left an UNEXPIRED lease, nothing published
    l1 = d["y-1k"].get("leases") or []
    dead_live = [l for l in l1 if l.get("owner_pid") == pid and (l.get("expires_at") or 0) > (l.get("now") or 0)]
    c.add("Y1", bool(kill.get("held")) and pid is not None and not rc["y-1"].startswith("rc=0") and bool(dead_live)
          and not (d["y-1k"].get("compartments") or []),
          "y-1: kill -9 of the DSH process while the historian holds the lease leaves an unexpired lease of the dead pid and no half-published compartment",
          {"kill": kill, "rc": rc["y-1"], "leases": l1, "compartments": len(d["y-1k"].get("compartments") or []),
           "inProgress": (d["y-1k"].get("meta") or {}).get("compartment_in_progress")})
    # Y2 — restart: the dead holder's lease neither blocks nor is waited out; passes run, nothing left behind
    steps = [r for r in events(out / "y-2-status.jsonl") if r.get("kind") == "step"]
    first = steps[0] if steps else {}
    m = re.search(r"elapsed=([0-9.]+)s", rc["y-2"])
    el = float(m.group(1)) if m else None
    seen_runs = {r.get("id") for r in (d["y-1k"].get("historianRuns") or [])}
    runs2 = [r for r in (d["y-2"].get("historianRuns") or []) if r.get("id") not in seen_runs]
    comps2 = d["y-2"].get("compartments") or []
    live2 = [l for l in (d["y-2"].get("leases") or []) if (l.get("expires_at") or 0) > (l.get("now") or 0)]
    still_dead = [l for l in (first.get("leases") or []) if l.get("owner_pid") == pid]
    c.add("Y2", rc["y-2"].startswith("rc=0") and bool(runs2) and all(r.get("status") in ("noop", "success") for r in runs2)
          and first.get("historianBusy") is False and not still_dead and not live2
          and (d["y-2"].get("meta") or {}).get("compartment_in_progress") in (0, None)
          and el is not None and el < 120,
          "y-2 (new process, dead holder's lease still unexpired): historian passes take the lease and run (noop/success, none reported busy), the busy probe reads false, no live lease or in-progress flag left, no 5-min TTL wait",
          {"rc": rc["y-2"], "historianRunsInY2": [(r.get("status"), r.get("failure_reason")) for r in runs2],
           "firstStep": {"historianBusy": first.get("historianBusy"), "leases": first.get("leases")},
           "compartments": [[x.get("start_message"), x.get("end_message")] for x in comps2], "liveLeases": live2,
           "meta": d["y-2"].get("meta")})
    # Y3 — no duplicate / overlapping compartment after a second restart
    comps3 = [(x.get("start_message"), x.get("end_message")) for x in (d["y-3"].get("compartments") or [])]
    starts = [a for a, _ in comps3]
    contiguous = all(comps3[i][0] == comps3[i - 1][1] + 1 for i in range(1, len(comps3)))
    kept = all((x.get("start_message"), x.get("end_message")) in comps3 for x in comps2)
    c.add("Y3", rc["y-3"].startswith("rc=0") and bool(comps3) and len(set(starts)) == len(starts) and contiguous and kept,
          "after the restarts the session's history is published (>= 1 compartment); no duplicate or overlapping compartment; earlier compartments kept",
          {"rc": rc["y-3"], "compartments": comps3})
    # Y4 — tag identity: unique, contiguous, every earlier tag keeps number + message id
    def tags(n):
        return {t["tag_number"]: t["message_id"] for t in (d[n].get("tags") or [])}
    t1, t2, t3 = tags("y-1k"), tags("y-2"), tags("y-3")
    def ok_ids(t):
        return sorted(t) == list(range(1, len(t) + 1)) and len(set(t.values())) == len(t)
    moved = {n: (t1[n], t3.get(n)) for n in t1 if t3.get(n) != t1[n]} | {n: (t2[n], t3.get(n)) for n in t2 if t3.get(n) != t2[n]}
    c.add("Y4", bool(t1) and ok_ids(t1) and ok_ids(t2) and ok_ids(t3) and not moved and len(t3) >= len(t1),
          "tag numbers unique and contiguous, message ids unique; every tag from before the kill keeps its number and message",
          {"tags": [len(t1), len(t2), len(t3)], "changed": moved})
    # Y5 — outbox settled, integrity_check ok, other session untouched
    ob = {n: {o.get("status"): o.get("n") for o in (d[n].get("outbox") or [])} for n in ("y-2", "y-3")}
    integ = {n: d[n].get("integrity") for n in ("y-1k", "y-2", "y-3")}
    xb, xa = d["x-5"], d["x-after-y"]
    other_same = bool(xa) and xb.get("tags") == xa.get("tags") and xb.get("compartments") == xa.get("compartments") \
        and xb.get("truncations") == xa.get("truncations")
    c.add("Y5", all(set(v) <= {"committed", "superseded", "abandoned"} for v in ob.values())
          and all(v == "ok" for v in integ.values()) and other_same,
          "outbox settled after restart; SQLite integrity_check ok after the kill and each restart; the other session (scenario X) unchanged",
          {"outbox": ob, "integrity": integ, "otherSessionUnchanged": other_same})
    # Y6 — raw data: what y-1 emitted before the kill is either whole in the DSH
    # log, or explicitly recorded by DSH as TOOL_OUTCOME_UNKNOWN (the step was
    # in flight: emitted on stdout, not yet durable — DSH's own restore marks it);
    # never a partial original. The later turns are appended to the same session.
    emitted = []
    for e in events(out / "y-1.log"):
        if e.get("type") == "tool_result":
            mm = re.search(r"MOCKSTEP:y1:(\d+)", json.dumps(e))
            if mm:
                emitted.append(int(mm.group(1)))
    calls = {}    # callId -> file k (y1-zh<k>)
    results = {}  # callId -> (marker k or None, whole, outcome unknown)
    for e in events(out / "y-session.jsonl"):
        dat = e.get("data") or {}
        if e.get("type") == "tool/call":
            mm = re.search(r"y1-zh(\d+)", json.dumps(dat))
            if mm:
                calls[dat.get("callId")] = int(mm.group(1))
        if e.get("type") == "tool/result":
            msg = dat.get("message") or {}
            text = "".join(b.get("text", "") for b in (msg.get("content") or []) if isinstance(b, dict))
            mm = re.findall(r"MOCKSTEP:y1:(\d+)", text)
            results[msg.get("toolCallId") or (msg.get("source") or {}).get("callId")] = (
                int(mm[0]) if mm else None, len(mm) >= 2, (dat.get("error") or {}).get("code") == "TOOL_OUTCOME_UNKNOWN")
    by_k = {k: results.get(cid) for cid, k in calls.items()}
    whole = sorted(k for k, r in by_k.items() if r and r[0] == k and r[1])
    unknown = sorted(k for k, r in by_k.items() if r and r[2])
    partial = sorted(k for k, r in by_k.items() if r and r[0] is not None and not r[1])
    missing = sorted(k for k, r in by_k.items() if r is None)
    accounted = {k: (k in whole) or (k in unknown) for k in set(emitted)}
    sess_text = (out / "y-session.jsonl").read_text(errors="replace") if (out / "y-session.jsonl").exists() else ""
    later = all(f"[[MOCK:{p}]]" in sess_text for p in ("y2", "y3"))
    c.add("Y6", bool(emitted) and bool(whole) and not partial and not missing and all(accounted.values()) and later,
          "raw data: every y-1 tool result is whole in the DSH session log or explicitly TOOL_OUTCOME_UNKNOWN (in flight at the kill, recorded by DSH's restore); no partial original; every call has a result; the y-2 / y-3 turns appended to the same session",
          {"emittedBeforeKill": sorted(set(emitted)), "wholeInLog": whole, "partial": partial,
           "outcomeUnknown(DSH)": unknown, "noResult": missing, "accounted": accounted,
           "laterTurnsAppended": later})


def check_f(c, out: Path, runs):
    """Round 27 C4 scenario F (ci-x.sh): the round 26 Y4 window made
    deterministic — the e2e-only crash point tail-fold-pending SIGKILLs DSH
    after the first tool result's tag is written and before the surface replace
    lands; a new process continues the session with a new user message."""
    names = ("f-1", "f-2")
    if not any(n in runs for n in names):
        c.add("F0", False, "scenario F ran (SIGKILL in the tail-fold window)", "no f-* runs")
        return
    rc = {n: runs.get(n, ("", "missing"))[1] for n in names}
    d1 = load_json(out / "db-f-1k.json") or {}
    d2 = load_json(out / "db-f-2.json") or {}
    log1 = (out / "f-1.log").read_text(errors="replace") if (out / "f-1.log").exists() else ""
    tools1 = [t for t in (d1.get("tags") or []) if t.get("type") == "tool"]
    sess = (out / "f-session.jsonl").read_text(errors="replace") if (out / "f-session.jsonl").exists() else ""
    # the raw tool/result event carries the file whole (its first AND last marker line)
    whole = False
    for e in events(out / "f-session.jsonl"):
        if e.get("type") == "tool/result":
            msg = (e.get("data") or {}).get("message") or {}
            text = "".join(b.get("text", "") for b in (msg.get("content") or []) if isinstance(b, dict))
            whole = whole or text.count("MOCKSTEP:f1:1") >= 2
    # F1 — the kill landed in the window: crash line, no completion, the first
    # call tagged under the synthetic tail owner, the second call never made
    c.add("F1", "crash point tail-fold-pending" in log1 and not rc["f-1"].startswith("rc=0")
          and len(tools1) == 1 and str(tools1[0].get("tool_owner_message_id") or "").startswith("synth-user-")
          and whole and "MOCKSTEP:f1:2" not in sess.split("[[MOCK:f2]]")[0],
          "f-1: SIGKILL at tail-fold-pending — the first tool result is whole in the DSH log, its tag is written under the synthetic tail owner, the replace never landed, step 2 never ran",
          {"rc": rc["f-1"], "crashLine": "crash point tail-fold-pending" in log1, "toolTags": tools1, "resultWhole": whole})
    # F2 — restart: the absorbing user message re-owns the call's tag; one row, same number
    call = tools1[0].get("message_id") if tools1 else None
    rows2 = [t for t in (d2.get("tags") or []) if t.get("type") == "tool" and t.get("message_id") == call]
    t2 = {t["tag_number"]: t["message_id"] for t in (d2.get("tags") or [])}
    ok_ids = sorted(t2) == list(range(1, len(t2) + 1)) and len(set(t2.values())) == len(t2)
    n1 = tools1[0].get("tag_number") if tools1 else None
    c.add("F2", rc["f-2"].startswith("rc=0") and call is not None and len(rows2) == 1 and rows2[0].get("tag_number") == n1
          and not str(rows2[0].get("tool_owner_message_id") or "").startswith("synth-user-") and ok_ids,
          "f-2 (new process, new user message absorbs the unreplaced fold): the call keeps ONE tag row with its pre-kill number, re-owned by a real message; tag numbers unique + contiguous",
          {"rc": rc["f-2"], "call": call, "before": n1, "after": rows2, "tags": len(t2), "uniqueContiguous": ok_ids})
    # F3 — what the model is shown after the restart: the result under that same §N§ only
    reqs = [r for r in x_requests(out) if r.get("plan") == "f2" and isinstance(r.get("tagged"), dict)]
    shown = sorted({n for r in reqs for n in (r["tagged"].get("MOCKSTEP:f1:1") or [])})
    c.add("F3", bool(reqs) and n1 is not None and shown == [n1],
          "f-2 requests show the first tool result under its pre-kill §N§ and no other number (round 26 Y4: the model saw §4§ for a §3§ result)",
          {"requests": len(reqs), "shownTags": shown, "expected": n1})


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

# ============================ round 24b scenario H ============================
H_CODE = re.compile(r"\b[A-Z]{2,}-[A-Z]{2,}-\d{3,}\b")
H_ARCH, H_RULE, H_FILE, H_TODO, H_TODO2 = ("ARCH-KESTREL-4127", "RULE-MARMOT-5830", "FILE-HERON-2261",
                                           "TODO-BISON-9074", "TODO-YAK-3318")
H_A_CODES = (H_ARCH, H_RULE, H_FILE, H_TODO)


def h_results(path: Path, tool: str):
    """(called, [completed result texts], [error result texts]) of one tool in one run."""
    calls, results = tool_calls(path, tool)
    ok = [str(r.get("result", "")) for r in results if r.get("status") == "completed"]
    bad = [str(r.get("result", r.get("error", ""))) for r in results if r.get("status") != "completed"]
    return bool(calls), ok, bad


def h_blocks(text: str):
    """Split a ctx_search answer into its numbered result blocks."""
    return [b for b in re.split(r"\n\n(?=\[\d+\] )", text) if re.match(r"\[\d+\] ", b)]


def h_flat(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def check_h(c, out: Path, runs):
    """Round 24b scenario H (task pack P1-1): memory CORRECTNESS across
    sessions and restarts — U13–U25. Each failure detail carries `class`:
    `product` (Magic returned/stored/injected the wrong thing) or
    `model` (the model did not call the tool / answered off-script while the
    Magic side was right), with the trigger."""
    asid = (out / "h-a.sid").read_text().strip() if (out / "h-a.sid").exists() else ""
    bsid = (out / "h-b.sid").read_text().strip() if (out / "h-b.sid").exists() else ""
    csid = (out / "h-c.sid").read_text().strip() if (out / "h-c.sid").exists() else ""
    final = load_json(out / "h-db-final.json") or {}
    sess = final.get("sessions") or {}
    mems = final.get("memories") if isinstance(final.get("memories"), list) else []
    a1 = load_json(out / "h-db-a1b.json") or load_json(out / "h-db-a1.json") or {}
    a1m = a1.get("memories") if isinstance(a1.get("memories"), list) else []
    facts = (out / "h-facts.txt").read_text().splitlines() if (out / "h-facts.txt").exists() else []

    # U13 the four facts were pinned, one code each, as written
    by_code = {code: [m for m in a1m if code in m.get("codes", []) and m.get("status", "active") == "active"] for code in H_A_CODES}
    mixed = [m["id"] for m in a1m if len(set(m.get("codes", [])) & set(H_A_CODES)) > 1]
    called = [n for n in ("h-f1", "h-f2", "h-f3", "h-f4", "h-f5") if tool_calls(out / f"{n}.log", "ctx_memory")[0]]
    c.add("U13", all(by_code.values()) and not mixed, "session A: each fact pinned as its own active memory (one codeword each)",
          {"perCode": {k: [m["id"] for m in v] for k, v in by_code.items()}, "mixed": mixed, "ctxMemoryCalledIn": called,
           "class": None if all(by_code.values()) else ("model" if len(called) < 4 else "product")})

    # U14 the historian compressed session A in >= 2 separate passes, the facts inside compartments
    reads = (out / "h-a.reads").read_text().split() if (out / "h-a.reads").exists() else ["0", "0"]
    acomps = ((sess.get(asid) or {}).get("compartments")) if asid else None
    acomps = acomps if isinstance(acomps, list) else []
    fact_codes_in_comps = sorted({x for cpt in acomps for x in cpt.get("codes", [])})
    last_end = max([cpt["range"][1] for cpt in acomps] or [0])
    # Round 24c: a compartment before the first search turn (h-aq) carries only
    # codewords its own messages carry (message-history rows in its range):
    # Magic's injected m0 / <ctx-search-hint> is not history (41672370986:
    # compartments 23-28, 29-33, 34-37 carried all four codes from the injected
    # <project-memory>).
    arows = ((sess.get(asid) or {}).get("factMessages")) if asid else None
    arows = [r for r in arows if not r.get("injected")] if isinstance(arows, list) else []
    search_turn = min([r["ordinal"] for r in arows if r.get("role") == "user" and "Call the ctx_search tool" in r.get("head", "")] or [10 ** 9])
    # Round 25b: a compartment's OWN codewords are those of every non-injected
    # message of the history view in its range — text, tool-call inputs and
    # tool results (h-a-history.json from ci-h-history.ts). The FTS rows above
    # hold user/assistant text only: in 41688260239 compartment [11, 15]
    # carried FILE-HERON-2261 from the agent's own ctx_memory write call
    # (ordinal 11, right after the fact-3 user message at 10) and was flagged.
    # Stricter on the injected side: no compartment may carry Magic's injected
    # block markup at all, the history view must exist, and its numbering must
    # agree with the FTS rows (each fact row's codes on the same ordinal).
    hist = load_json(out / "h-a-history.json") or {}
    hrows = hist.get("rows") if isinstance(hist.get("rows"), list) else []
    hreal = [r for r in hrows if not r.get("injected")]
    hby = {r["ordinal"]: set(r.get("codes", [])) for r in hreal}
    numbering_mismatch = [r["ordinal"] for r in arows if not set(r.get("codes", [])) <= hby.get(r["ordinal"], set())]
    markup = [x["range"] for x in acomps if x.get("injectedMarkup") is not False]
    foreign = []
    for x in acomps:
        lo, hi = x["range"]
        if hi >= search_turn:
            continue
        own_codes = {cd for r in hreal if lo <= r["ordinal"] <= hi for cd in r.get("codes", [])}
        extra = sorted(set(x.get("codes", [])) - own_codes)
        if extra:
            foreign.append((x["range"], extra))
    # Round 26 (e2e 41769676548): since 8a7864594 (core parity) the historian
    # prompt carries a <project-memory> dedup block with every ACTIVE memory, so
    # a summary can restate a code that is already an active memory before the
    # pass (h-db-a2 = the state before the first pass). That is a model
    # attribution slip, not a leak of unseen text: WARN, not FAIL. A code that
    # is in neither the range nor that block still FAILS.
    pre_mem = {cd for m in ((load_json(out / "h-db-a2.json") or {}).get("memories") or [])
               if isinstance(m, dict) and m.get("status", "active") in ("active", "permanent") for cd in m.get("codes", [])}
    unexplained = [(r, [cd for cd in ex if cd not in pre_mem]) for r, ex in foreign]
    unexplained = [(r, ex) for r, ex in unexplained if ex]
    ok14 = int(reads[1]) >= 2 and len(acomps) >= 2 and bool(arows) and bool(hreal) and not numbering_mismatch \
        and not markup and not unexplained
    c.add("U14", (True if not foreign else "warn") if ok14 else False,
          "session A: historian published compartments in >= 2 passes, covering the four fact turns; no compartment carries a codeword no message (text, tool call or result) in its range carries, nor injected-block markup",
          {"readTurns": reads[0], "passesWithNewCompartments": reads[1], "compartments": [(x["range"], x["codes"]) for x in acomps],
           "foreignCodes": foreign, "foreignNotInProjectMemoryBlock": unexplained, "injectedMarkup": markup, "historyRows": len(hrows), "numberingMismatch": numbering_mismatch,
           "codesInCompartmentText": fact_codes_in_comps, "searchTurnOrdinal": search_turn if search_turn < 10 ** 9 else None})

    # U15 automatic injection: the NEW session's injected m0 <project-memory> carries the four codes
    bm0 = ((load_json(out / "h-db-b1.json") or {}).get("sessions") or {}).get(bsid, {}).get("m0") if bsid else None
    bm0 = bm0 if isinstance(bm0, dict) else {}
    c.add("U15", bm0.get("hasProjectMemory") is True and set(H_A_CODES) <= set(bm0.get("projectMemoryCodes") or []),
          "session B (new): injected <project-memory> carries all four codewords",
          {"m0": bm0, "class": "product" if bm0 else "missing"})

    # The FILE fact's OWN user message ordinal, from session A's message-history
    # FTS rows (h-db-final.json), independent of what ctx_search printed
    # (round 24c: 41672370986 U16 took the ordinal from the search output only).
    fmsgs = ((sess.get(asid) or {}).get("factMessages")) if asid else None
    fmsgs = fmsgs if isinstance(fmsgs, list) else []
    own = [m for m in fmsgs if m.get("role") == "user" and H_FILE in m.get("codes", []) and "Fact 3 of 4" in m.get("head", "")]
    fact_ord = own[0]["ordinal"] if own else None
    injected_rows = [m["ordinal"] for m in fmsgs if m.get("injected")]
    INJ = ("<project-memory>", "<session-history>", "<ctx-search-hint>", "related fragments")

    # U16 ctx_search message lane: the FILE fact's own user message. Core folds a
    # message hit into the compartment that covers it when the compartment
    # (semantic) lane returns that compartment (search.ts
    # mergeMessageAndCompartmentResults: match=hybrid, Snippet = the message), so
    # the hit is EITHER `ordinal=<fact> role=user` with the codeword OR
    # `compartment_id=… range=a-b match=hybrid` with a <= fact <= b and the
    # codeword in its Snippet. No other fact's codeword in it, no injected block
    # in any message result, none indexed.
    ok_call, res, err = h_results(out / "h-aq.log", "ctx_search")
    text = res[0] if res else ""
    msg = [b for b in h_blocks(text) if "[message]" in b.split("\n", 1)[0]]

    def h_covers(block, ordinal):
        head = block.split("\n", 1)[0]
        if ordinal is None or H_FILE not in block:
            return False
        m = re.search(r"ordinal=(\d+) range=\d+-\d+ role=user", head)
        if m:
            return int(m.group(1)) == ordinal
        m = re.search(r"compartment_id=\d+ range=(\d+)-(\d+) match=hybrid", head)
        return bool(m) and int(m.group(1)) <= ordinal <= int(m.group(2)) and H_FILE in block.split("Snippet:", 1)[-1]

    hit = next((b for b in msg if h_covers(b, fact_ord)), None)
    # Round 25b: a FOLDED hit's head line is its compartment's title (historian
    # text over the whole range). e2e 41696491092: hit = compartment [1, 12]
    # titled "Saved three … facts (ARCH-KESTREL-4127, RULE-MARMOT-5830,
    # FILE-HERON-2261)" — facts 1–3 are its own messages (ordinals 3, 7, 10),
    # so the title legitimately names them. "No other fact mixed in" is judged
    # on what the hit presents as the match: the Snippet (the message) must
    # carry no other fact's codeword, and the title may only name codewords its
    # own range's messages carry (h-a-history.json, as U14). A plain message hit
    # (ordinal=…) is judged on the whole block, as before.
    others = []
    if hit:
        fm = re.search(r"compartment_id=\d+ range=(\d+)-(\d+) match=hybrid", hit.split("\n", 1)[0])
        if fm:
            lo, hi = int(fm.group(1)), int(fm.group(2))
            head, _, snippet = hit.partition("Snippet:")
            range_codes = {cd for r in hreal if lo <= r["ordinal"] <= hi for cd in r.get("codes", [])}
            others = [x for x in H_A_CODES if x != H_FILE and (x in snippet or (x in head and x not in range_codes))]
            if not hreal:
                others = others or ["<no history view>"]
        else:
            others = [x for x in H_A_CODES if x != H_FILE and x in hit]
    inj_hits = [b[:120] for b in msg if any(k in b for k in INJ)]
    c.add("U16", hit is not None and not others and not inj_hits and not injected_rows,
          "ctx_search message lane returns the fact's own user message (its ordinal, or folded into the compartment covering it), no other fact mixed in, no injected block",
          {"called": ok_call, "factOrdinal": fact_ord, "hit": (hit or "")[:240], "otherCodesInHit": others,
           "injectedInResults": inj_hits[:2], "injectedRowsIndexed": injected_rows, "errors": err[:1],
           "class": None if (hit and not inj_hits and not injected_rows) else ("model" if not ok_call else ("missing" if fact_ord is None else "product"))})

    # U17 ctx_expand returns the ORIGINAL text, over a range that covers the fact
    ok_x, xres, xerr = h_results(out / "h-aq.log", "ctx_expand")
    f_file = next((f for f in facts if H_FILE in f), "")

    def h_expand_covers(r):
        m = re.match(r"Messages (\d+)-(\d+)", r)
        return fact_ord is not None and bool(m) and int(m.group(1)) <= fact_ord <= int(m.group(2))

    exp_ok = any(h_flat(f_file) in h_flat(r) and h_expand_covers(r) for r in xres)
    c.add("U17", exp_ok, "ctx_expand of the hit's range covers the fact's ordinal and contains the original fact sentence verbatim",
          {"called": ok_x, "factOrdinal": fact_ord, "expanded": [r[:240] for r in xres], "errors": xerr[:1], "answer": (final_text(out / "h-aq.log") or "")[:200],
           "class": None if exp_ok else ("model" if not ok_x else "product")})

    # U18 compartment (semantic) lane: a paraphrase finds the compartment covering the FILE fact
    ok_s, sres, serr = h_results(out / "h-as.log", "ctx_search")
    stext = sres[0] if sres else ""
    cmp_lines = re.findall(r"compartment_id=(\d+) range=(\d+)-(\d+)", stext)
    covers = fact_ord is not None and any(int(a) <= fact_ord <= int(b) for _, a, b in cmp_lines)
    chunks = ((sess.get(asid) or {}).get("chunks")) if asid else None
    s_inj = [b[:120] for b in h_blocks(stext) if any(k in b for k in INJ)]
    c.add("U18", covers and not s_inj and "semantic search unavailable" not in stext,
          "ctx_search compartment lane: a codeword-free paraphrase returns the compartment covering the fact (no injected block in the results)",
          {"called": ok_s, "compartmentHits": cmp_lines, "factOrdinal": fact_ord, "chunkEmbeddings": chunks, "injectedInResults": s_inj[:2],
           "head": stext[:240], "class": None if (covers and not s_inj) else ("model" if not ok_s else "product")})

    # U19 degrade: no reachable embedding model -> full-text answer + visible note, never an error
    ok_d, dres, derr = h_results(out / "h-ad.log", "ctx_search")
    dtext = dres[0] if dres else ""
    rule_hit = any(H_RULE in b for b in h_blocks(dtext) if "[message]" in b.split("\n", 1)[0])
    c.add("U19", ok_d and not derr and rule_hit and "semantic search unavailable" in dtext and "full-text" in dtext,
          "embedding endpoint down: ctx_search still answers from full-text and says so (no error)",
          {"called": ok_d, "errors": derr[:1], "ruleHit": rule_hit, "tail": dtext[-260:]})

    # U20 cross-session recall in different words, each answer the right code (no swap)
    ans = final_text(out / "h-b1.log") or ""
    want = {"1": H_ARCH, "2": H_RULE, "3": H_FILE, "4": H_TODO}
    got = {}
    for line in ans.splitlines():
        m = re.match(r"\s*\**\s*([1-4])\s*[:.)]\s*(.*)$", line)
        if m:
            got[m.group(1)] = m.group(2)
    wrong = {k: v for k, v in got.items() if want[k] not in v or any(x in v for x in H_A_CODES if x != want[k])}
    c.add("U20", len(got) == 4 and not wrong, "session B (new, after restart): four paraphrased questions → the right codeword each",
          {"answer": ans[:300], "wrong": wrong, "toolsUsed": [t for t in ("ctx_search", "ctx_memory", "ctx_expand") if tool_calls(out / "h-b1.log", t)[0]],
           "class": None if (len(got) == 4 and not wrong) else ("product" if not set(H_A_CODES) <= set(bm0.get("projectMemoryCodes") or []) else "model")})

    # U21 the modification is stored: old todo no longer active, new todo active
    old_active = [m for m in mems if H_TODO in m.get("codes", []) and H_TODO2 not in m.get("codes", []) and m.get("status", "active") == "active"]
    new_active = [m for m in mems if H_TODO2 in m.get("codes", []) and m.get("status", "active") == "active"]
    c.add("U21", not old_active and bool(new_active), "after the correction: old todo memory not active, new todo memory active",
          {"oldActive": [(m["id"], m.get("category"), m.get("src")) for m in old_active],
           "newActive": [m["id"] for m in new_active], "allTodo": [(m["id"], m.get("status"), m.get("codes")) for m in mems if set(m.get("codes", [])) & {H_TODO, H_TODO2}],
           "ctxMemoryCalled": bool(tool_calls(out / "h-b2.log", "ctx_memory")[0]),
           "class": None if (not old_active and new_active) else ("model" if not tool_calls(out / "h-b2.log", "ctx_memory")[0] else "product")})

    # U22 a new session gets the NEW value (answer + injected memory), never the old one
    ans_c = final_text(out / "h-c1.log") or ""
    cm0 = ((load_json(out / "h-db-c1.json") or {}).get("sessions") or {}).get(csid, {}).get("m0") if csid else None
    cm0 = cm0 if isinstance(cm0, dict) else {}
    pm = set(cm0.get("projectMemoryCodes") or [])
    # Round 26 (e2e 41769676548): the agent's own replacement memory may NAME
    # the old code ("This replaces the cancelled TODO-BISON-9074"). The old
    # code in the injected block is stale only when an active memory carries
    # it WITHOUT the new code (U21's definition of a stale todo).
    stale_src = [m["id"] for m in mems if H_TODO in m.get("codes", []) and H_TODO2 not in m.get("codes", [])
                 and m.get("status", "active") == "active"]
    old_injected_stale = H_TODO in pm and bool(stale_src)
    c.add("U22", H_TODO2 in ans_c and H_TODO not in ans_c and H_TODO2 in pm and not old_injected_stale,
          "session C (new): current todo answered and injected with the NEW codeword; the old one is not injected as a live fact",
          {"answer": ans_c[:200], "m0ProjectMemoryCodes": sorted(pm), "staleActiveSources": stale_src,
           "oldNamedOnlyInReplacement": H_TODO in pm and not stale_src,
           "class": None if (H_TODO2 in pm and not old_injected_stale) else "product"})

    # U23 ctx_search after the change: new value, no stale active memory, no session-A history leaking into C
    ok_c2, c2res, _ = h_results(out / "h-c2.log", "ctx_search")
    c2 = c2res[0] if c2res else ""
    blocks = h_blocks(c2)
    stale = [b[:160] for b in blocks if H_TODO in b and H_TODO2 not in b]
    leak = [b[:160] for b in blocks if "[message]" in b.split("\n", 1)[0] and any(x in b for x in H_A_CODES)]
    # A memory already shown in the session's <project-memory> is suppressed from
    # ctx_search by design (visibleMemoryIds), so the new value counts as
    # returned when it is in the results OR in C's injected <project-memory>.
    new_seen = any(H_TODO2 in b for b in blocks) or H_TODO2 in pm
    c.add("U23", ok_c2 and new_seen and not stale and not leak,
          "session C ctx_search: new todo returned (or already injected), no stale old-todo result, no session-A message in C's history lanes",
          {"called": ok_c2, "newInResults": any(H_TODO2 in b for b in blocks), "newInjected": H_TODO2 in pm, "stale": stale, "leak": leak, "head": c2[:240], "answer": (final_text(out / "h-c2.log") or "")[:120],
           "class": None if (not stale and not leak) else "product"})

    # U24 never-recorded fact: no invented codeword (relaxed recall ORs words, so search hits are not judged)
    ans3 = final_text(out / "h-c3.log") or ""
    codes3 = sorted(set(H_CODE.findall(ans3)))
    invented = [x for x in codes3 if x not in H_A_CODES + (H_TODO2, CODEWORD)]
    misattributed = [x for x in codes3 if x not in invented]
    ran3 = bool(ans3.strip())
    c.add("U24", False if not ran3 else (True if (not invented and not misattributed) else ("warn" if not invented else False)),
          "never-recorded fact: the answer contains no invented codeword",
          {"answer": ans3[:200], "invented": invented, "recordedCodeGivenForWrongFact": misattributed,
           "notRecorded": "NOT RECORDED" in ans3.upper(), "class": "model" if invented else None})

    # U25 no cross-session mixing in stored/injected history
    a_bad = [x for x in acomps if H_TODO2 in x.get("codes", [])]
    csh = set(cm0.get("sessionHistoryCodes") or [])
    c.add("U25", bool(acomps) and bool(cm0) and not a_bad and not (csh & set(H_A_CODES)),
          "no cross-session mixing: A's compartments never carry B's new todo; C's <session-history> carries none of A's facts",
          {"aCompartmentsWithB": a_bad, "cSessionHistoryCodes": sorted(csh)})

    # U26 (round 25, e2e 41682984222 U21: the historian re-promoted the todo under
    # the raw directory, beside the agent's identity row) every scenario memory is
    # stored under a resolved project identity and no exact duplicate is active
    def _norm(t):
        return re.sub(r"\s+", " ", (t or "").lower()).strip()
    with_p = [m for m in mems if "p" in m]
    raw_path = [(m["id"], m.get("st"), m.get("p")) for m in with_p if not str(m.get("p") or "").startswith(("git:", "dir:"))]
    seen_keys, dups = {}, []
    for m in mems:
        if m.get("status", "active") not in ("active", "permanent"):
            continue
        k = (m.get("category"), _norm(m.get("content")))
        if k in seen_keys:
            dups.append((seen_keys[k], m["id"]))
        else:
            seen_keys[k] = m["id"]
    c.add("U26", bool(with_p) and not raw_path and not dups,
          "memory identity: every scenario memory under a git:/dir: project identity, no exact duplicate active",
          {"rawPath": raw_path, "activeDuplicates": dups, "projectPaths": sorted({str(m.get("p")) for m in with_p}),
           "sourceTypes": sorted({str(m.get("st")) for m in with_p}), "class": None if (with_p and not raw_path and not dups) else "product"})


def check_w(c, out: Path, runs):
    """Round 25 scenario W (P1-3, ci-x.sh): the worker self-test on the mock
    model; the worker's CHILD (allowlist read/grep/glob) is FORCED to call bash
    and write. W1 ran, W2 the forced calls were emitted to the child, W3 each
    was refused as an unknown tool with no effect on disk, W4 the child was
    offered only allowlisted tools while the parent kept its own (no leak)."""
    if "w-1" not in runs:
        c.add("W0", False, "scenario W ran (worker self-test on the mock)", "no w-1 run")
        return
    rc = runs.get("w-1", ("", "missing"))[1]
    rep = selftest_report(out / "w-1.log")
    fin = final_text(out / "w-1.log") or ""
    c.add("W1", rc.startswith("rc=0") and bool(rep and rep.get("ok")) and "DONE w1" in fin,
          "w-1: worker self-test ran on the mock model and the parent turn completed",
          {"rc": rc, "ok": (rep or {}).get("ok"), "visible": (rep or {}).get("childVisibleTools"), "final": fin[:120]})
    reqs = x_requests(out)
    child = [r for r in reqs if r.get("plan") == "wchild"]
    parent = [r for r in reqs if r.get("plan") == "w1"]
    emitted = sorted({r.get("step") for r in child if r.get("outcome") == "tool"})
    c.add("W2", 1 in emitted and 2 in emitted, "the child was made to call bash (step 1) and write (step 2) although neither is allowlisted",
          {"childRequests": len(child), "toolStepsEmitted": emitted})
    raw = (out / "w-child.jsonl").read_text(errors="replace") if (out / "w-child.jsonl").exists() else ""
    unknown = {t: bool(re.search(r'unknown tool \\?"' + t + r'\\?"', raw)) for t in ("bash", "write")}
    files = [l for l in ((out / "w-forced-files.txt").read_text().splitlines() if (out / "w-forced-files.txt").exists() else []) if l.strip()]
    ran = "FORCED-BASH-RAN" in raw.replace("echo FORCED-BASH-RAN", "")
    c.add("W3", bool(raw) and all(unknown.values()) and not files and not ran,
          "forced bash / write calls are refused by the executor (unknown tool) and change nothing on disk",
          {"childLog": bool(raw), "unknownTool": unknown, "forcedFiles": files, "bashOutputSeen": ran})
    child_tools = sorted({t for r in child for t in (r.get("tools") or [])})
    parent_after = [r for r in parent if (r.get("step") or 0) >= 2 or r.get("outcome") == "text"]
    parent_tools = sorted({t for r in parent_after for t in (r.get("tools") or [])})
    c.add("W4", bool(child_tools) and set(child_tools) <= ALLOWED_CHILD_TOOLS and {"bash", "write"} <= set(parent_tools),
          "the child is offered only allowlisted tools; the parent still has bash/write after the worker (no leak either way)",
          {"childTools": child_tools, "parentToolsAfter": parent_tools[:40]})


def check_s(c, out: Path, runs):
    """Round 25 scenario S (P1-2, ci-x.sh): 5 sessions x 4 rounds on the mock
    model, each round in parallel, every run a restart, one shared DB."""
    names = [f"s-{i}-{j}" for j in (1, 2, 3, 4) for i in (1, 2, 3, 4, 5)]
    if not any(n in runs for n in names):
        c.add("ST0", False, "scenario S ran (multi-session stress, mock)", "no s-* runs")
        return
    rc = {n: runs.get(n, ("", "missing"))[1] for n in names}
    fin = {n: final_text(out / f"{n}.log") or "" for n in names}
    bad = [n for n in names if not rc[n].startswith("rc=0") or f"DONE s{n.split('-')[1]}r{n.split('-')[2]}" not in fin[n]]
    # Round 25b: the 25 warm-up runs (5 one-line turns per session, ci-x.sh)
    # must also exit 0, finish their plan and stay in their session.
    wnames = [f"sw-{i}-{k}" for k in (1, 2, 3, 4, 5) for i in (1, 2, 3, 4, 5)]
    for n in wnames:
        wrc = runs.get(n, ("", "missing"))
        rc[n], fin[n] = wrc[1], final_text(out / f"{n}.log") or ""
        same = wrc[0] and wrc[0] == runs.get(f"s-{n.split('-')[1]}-1", ("", ""))[0]
        if not wrc[1].startswith("rc=0") or f"DONE s{n.split('-')[1]}w{n.split('-')[2]}" not in fin[n] or not same:
            bad.append(n)
    c.add("ST1", not bad, "all 20 runs (5 sessions x 4 parallel rounds, each a restart) and the 25 warm-up turns before them exit 0 and finish their plan",
          {"bad": {n: (rc[n], fin[n][:60]) for n in bad}})
    dumps = {j: load_json(out / f"s-db-r{j}.json") or {} for j in (1, 2, 3, 4)}
    last = dumps[4].get("sessions") or {}
    sids = [s for s in ((out / "s.sids").read_text().strip().split(",") if (out / "s.sids").exists() else []) if s]
    structural = {s: {k: v for k, v in (last.get(s) or {}).items() if k in ("duplicates", "overlaps", "gaps", "duplicateTagNumbers") and v}
                  for s in sids}
    structural = {s: v for s, v in structural.items() if v}
    c.add("ST2", len(sids) == 5 and bool(last) and not structural and dumps[4].get("integrity") == "ok",
          "no duplicate / overlapping / gapped compartments, no duplicate tag numbers, integrity ok",
          {"sessions": len(sids), "issues": structural, "integrity": dumps[4].get("integrity")})
    residue = {}
    for s in sids:
        row = last.get(s) or {}
        r = {}
        if row.get("liveLeases"):
            r["liveLeases"] = row["liveLeases"]
        if (row.get("meta") or {}).get("cip"):
            r["compartmentInProgress"] = row["meta"]["cip"]
        if row.get("outboxOpen"):
            r["outboxOpen"] = row["outboxOpen"]
        if r:
            residue[s] = r
    procs = [l for l in ((out / "s-leftover-procs.txt").read_text().splitlines() if (out / "s-leftover-procs.txt").exists() else []) if l.strip()]
    c.add("ST3", not residue and not procs, "no residue after the runs: no live lease, no compartment-in-progress flag, no open outbox op, no process left",
          {"residue": residue, "procs": procs[:5]})
    sizes = [((dumps[j].get("bytes") or {}).get("db", 0) + (dumps[j].get("bytes") or {}).get("wal", 0)) for j in (1, 2, 3, 4)]
    d_prev, d_last = max(sizes[1] - sizes[0], sizes[2] - sizes[1]), sizes[3] - sizes[2]
    def times(j):
        vals = []
        for i in (1, 2, 3, 4, 5):
            p = out / f"s-{i}-{j}.time"
            try:
                kb, sec = p.read_text().split()[-2:]
                vals.append((int(kb), float(sec)))
            except Exception:
                pass
        return vals
    t1, t3 = times(1), times(4)
    rss1 = max((v[0] for v in t1), default=None)
    rss3 = max((v[0] for v in t3), default=None)
    sec1 = sorted(v[1] for v in t1)[len(t1) // 2] if t1 else None
    sec3 = sorted(v[1] for v in t3)[len(t3) // 2] if t3 else None
    growth_ok = sizes[3] > 0 and sizes[3] < 64 * 1024 * 1024 and d_last <= 3 * max(d_prev, 0) + 2 * 1024 * 1024
    rss_ok = rss1 is None or rss3 is None or rss3 <= rss1 * 1.5 + 100 * 1024
    time_ok = sec1 is None or sec3 is None or sec3 <= sec1 * 2 + 15
    c.add("ST4", growth_ok and rss_ok and time_ok,
          "no abnormal growth: DB(+WAL) growth per round bounded, max RSS and median wall time of round 4 within bounds of round 1",
          {"dbBytes": sizes, "rssKb": [rss1, rss3], "medianSec": [sec1, sec3], "rows": dumps[4].get("rows"), "pages": dumps[4].get("pages")})
    hist = {s: (last.get(s) or {}).get("historianRuns") for s in sids}
    comps = {s: (last.get(s) or {}).get("compartments") for s in sids}
    fails = {s: ((last.get(s) or {}).get("meta") or {}).get("hf") for s in sids}
    c.add("ST5", any((v or 0) > 0 for v in comps.values()),
          "the stress exercised the historian: compartments were published under concurrency",
          {"compartments": comps, "historianRuns": hist, "failureCounts": fails})


def check_t(c, out: Path, runs):
    """T1–T4 (round 26, scenario T, limitation 17 / P1-2)."""
    if "t-1" not in runs:
        c.add("T0", False, "scenario T ran (/compact with <unprocessed_from>)", "no t-* runs")
        return
    code = (out / "t.codeword").read_text().strip() if (out / "t.codeword").exists() else "OTTER-LANTERN-6152"
    rc = {n: runs.get(n, ("", "missing"))[1] for n in ("t-1", "t-2", "t-3", "t-4")}
    done = e2e_lines(out / "t-3.log", "/compact at idle: done")
    c.add("T1", all(v.startswith("rc=0") for v in rc.values()) and bool(done) and "kind=success" in done[0],
          "scenario T runs exit 0 and the e2e /compact at idle (t-3) succeeded", {"rc": rc, "done": [d[-200:] for d in done[:1]]})
    t = load_json(out / "t-tail.json") or {}
    cons = t.get("constraint") or {}
    s_ord = cons.get("historyOrdinal")
    hr = [r for r in (t.get("historianRuns") or []) if isinstance(r, dict)]
    deferred = [r for r in hr if s_ord is not None and r.get("unprocessed_from") == s_ord
                and (r.get("chunk_end_ordinal") or 0) >= s_ord]
    comps = [r for r in (t.get("compartments") or []) if isinstance(r, dict)]
    last_end = max([r.get("end_message") or 0 for r in comps], default=0)
    c.add("T2", bool(cons.get("found")) and bool(deferred) and last_end < (s_ord or 0),
          "the /compact mini-historian answered <unprocessed_from> = the constraint's ordinal; compartments end before it",
          {"constraintOrdinal": s_ord, "historianRuns": hr[-3:], "lastCompartmentEnd": last_end,
           "error": (out / "t-tail.err").read_text(errors="replace")[-300:] if (out / "t-tail.err").exists() else ""})
    cps = [x for x in (t.get("compactions") or []) if isinstance(x, dict)]
    tail = (cps[-1].get("tail") if cps else None) or {}
    leaks = [h for h in (t.get("surfaceHits") or []) if isinstance(h, dict) and not h.get("summary")]
    ok3 = bool(cps) and bool(tail) and tail.get("carriesCodeword") is True and s_ord is not None \
        and (tail.get("from") or 0) <= s_ord <= (tail.get("to") or -1) and cons.get("originalOnSurface") is False and not leaks
    c.add("T3", ok3,
          "the checkpoint shadows the constraint and its summary carries it in <unsummarized_tail> (no other surface copy)",
          {"compactions": cps[-2:], "originalOnSurface": cons.get("originalOnSurface"), "otherSurfaceHits": leaks[:3]})
    final4 = final_text(out / "t-4.log") or ""
    calls4 = [ev.get("tool") for ev in events(out / "t-4.log") if ev.get("type") == "tool_call"]
    # Anything injected into t-4's own turn that carries the codeword (a
    # ctx-search hint) would make the answer unattributable to the summary.
    evs4 = session_events(out / "t-session-4.jsonl")
    start4 = next((i for i, e in enumerate(evs4) if "Name a colour. Answer from" in json.dumps(e.get("data") or {}, ensure_ascii=False)), None)
    inj4 = [e.get("type") for e in (evs4[start4 + 1:] if start4 is not None else [])
            if code in json.dumps(e.get("data") or {}, ensure_ascii=False)
            and "ctx-search-hint" in json.dumps(e.get("data") or {}, ensure_ascii=False)]
    obeyed = code in final4
    c.add("T4", (True if not calls4 and not inj4 else "warn") if obeyed else False,
          "restart: asked to name a colour (tools forbidden), the model answers the codeword from the summary",
          {"rc": rc["t-4"], "final": final4[:200], "toolCalls": calls4, "codewordInjectedInTurn": inj4[:3]})


def check_m(c, out: Path, runs):
    """M1–M5 (round 26, scenario M, P0-1 legacy migration via the built CLI)."""
    if not (out / "m-digests.json").exists():
        c.add("M0", False, "scenario M ran (legacy migration through the built CLI)", "no m-digests.json")
        return
    d = load_json(out / "m-digests.json") or {}
    txt = lambda n: (out / f"m-{n}.txt").read_text(errors="replace") if (out / f"m-{n}.txt").exists() else ""
    st = lambda n: load_json(out / f"m-state-{n}.json") or {}
    pre, app, res, fin = st("pre"), st("apply"), st("restore"), st("final")
    c.add("M1", "rc=0" in txt("scan") and "rc=0" in txt("dry") and "unique: 1" in txt("scan") and "Dry run" in txt("dry")
          and bool(d.get("pre")) and d.get("pre") == d.get("scan") == d.get("dry"),
          "scan and --dry-run are read-only (logical digest unchanged) and classify the legacy rows",
          {"digests": {k: (v or "")[:12] for k, v in d.items()}, "scan": txt("scan")[:240]})
    act = app.get("activeUnderIdentity") or []
    c.add("M2", "rc=0" in txt("apply") and "rollback:" in txt("apply") and d.get("backup") == "present"
          and "unique" in act and act.count("live") == 1 and "cancelled" not in act
          and app.get("memoryCount") == pre.get("memoryCount") and app.get("ftsInjected") == 0 and (app.get("legacyFlags") or 0) >= 1,
          "--apply: backup, unique fact under the identity, duplicate archived, cancelled stays cancelled, nothing deleted, FTS cleaned, compartment flagged",
          {"apply": txt("apply")[-300:], "state": {k: app.get(k) for k in ("activeUnderIdentity", "memoryCount", "ftsInjected", "legacyFlags")}, "preCount": pre.get("memoryCount")})
    c.add("M3", "Nothing to apply" in txt("apply2") and d.get("apply2") == d.get("apply"),
          "--apply again is a no-op (idempotent)", txt("apply2")[-160:])
    c.add("M4", "rc=0" in txt("restore") and "MATCH" in txt("restore") and d.get("restore") == d.get("pre")
          and res.get("memories") == pre.get("memories"),
          "--restore <backup> reproduces the pre-migration DB (digest MATCH)", txt("restore")[-240:])
    rows = []
    if (out / "m-requests.jsonl").exists():
        for line in (out / "m-requests.jsonl").read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    def hits(prefix):
        rs = [r for r in rows if str(r.get("session", "")).startswith(prefix) and r.get("outcome") in ("text", "tool")]
        return sorted({n for r in rs for n in (r.get("needles") or [])}), len(rs)
    hp, np_ = hits("mc-ci-m-pre-")
    ho, no = hits("mc-ci-m-post-")
    rc = {n: runs.get(n, ("", "missing"))[1] for n in ("m-pre", "m-post")}
    c.add("M5", all(v.startswith("rc=0") for v in rc.values()) and np_ > 0 and no > 0
          and "RULE-MARMOT-5830" not in hp and "RULE-MARMOT-5830" in ho and "TODO-BISON-9074" not in ho
          and "unique" in (fin.get("activeUnderIdentity") or []),
          "real DSH: the raw-path fact reaches the model only after the migration; the cancelled fact never does",
          {"rc": rc, "preNeedles": hp, "postNeedles": ho, "requests": [np_, no]})


def check_e(c, out: Path, runs):
    """E1–E2 (round 26, scenario E, P1-3): exact-identifier ranking, bag-of-words
    mock vs a real embedding model on the same session-A history."""
    if "e-bow-q" not in runs:
        c.add("E0", False, "scenario E ran (ranking: bag of words vs real embeddings)", "no e-* runs")
        return
    codes = (out / "e.codes").read_text().split() if (out / "e.codes").exists() else []
    hist = load_json(out / "h-a-history.json") or {}
    first_ord = {}
    for r in hist.get("rows") or []:
        for cd in r.get("codes", []):
            if not r.get("injected") and cd not in first_ord:
                first_ord[cd] = r.get("ordinal")

    def ranks(name):
        _, ok, bad = h_results(out / f"{name}.log", "ctx_search")
        res = {}
        for code, text in zip(codes, ok[: len(codes)]):
            blocks = h_blocks(text)
            by_text = next((i + 1 for i, b in enumerate(blocks) if code in b), None)
            by_range = None
            o = first_ord.get(code)
            for i, b in enumerate(blocks):
                m = re.search(r"range=(\d+)-(\d+)", b)
                if o is not None and m and int(m.group(1)) <= o <= int(m.group(2)):
                    by_range = i + 1
                    break
            res[code] = {"text": by_text, "range": by_range, "n": len(blocks)}
        para = h_blocks(ok[len(codes)]) if len(ok) > len(codes) else []
        return res, len(ok), len(bad), [h_flat(b)[:90] for b in para[:3]]

    bow = ranks("e-bow-q")
    real = ranks("e-real-q") if "e-real-q" in runs else ({}, 0, 0, [])
    real_rows = [json.loads(l) for l in (out / "e-real-requests.jsonl").read_text().splitlines() if l.strip()] if (out / "e-real-requests.jsonl").exists() else []
    real_req = len(real_rows)
    real_inputs = sum(int(r.get("n") or 0) for r in real_rows)  # > requests ⇒ stored content was (re-)embedded too
    rc = {n: runs.get(n, ("", "missing"))[1] for n in ("e-bow-q", "e-real-q")}
    ok1 = all(v.startswith("rc=0") for v in rc.values()) and bow[1] >= len(codes) and real[1] >= len(codes) and real_req > 0
    c.add("E1", ok1, "scenario E: both embedding backends answered every ctx_search on session A (real model served requests)",
          {"rc": rc, "results": {"bow": bow[1], "real": real[1]}, "errors": {"bow": bow[2], "real": real[2]}, "realEmbedRequests": real_req, "realEmbedInputs": real_inputs,
           "embedder": (out / "e-real-embed.log").read_text(errors="replace")[-200:] if (out / "e-real-embed.log").exists() else ""})
    best = lambda r: min([x for x in (r.get("text"), r.get("range")) if x is not None], default=None)
    not_first_real = [cd for cd in codes if best(real[0].get(cd, {})) != 1]
    c.add("E2", (True if not not_first_real else "warn") if ok1 else False,
          "exact identifier ranked first with the REAL embedding model (WARN = ranking issue confirmed with real embeddings)",
          {"real": real[0], "bow": bow[0], "notFirstReal": not_first_real,
           "notFirstBow": [cd for cd in codes if best(bow[0].get(cd, {})) != 1],
           "paraphraseTop3": {"bow": bow[3], "real": real[3]}})


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
    check_x(c, out, runs)
    check_y(c, out, runs)
    check_f(c, out, runs)
    check_w(c, out, runs)
    check_s(c, out, runs)
    check_r22_k(c, out, runs)
    check_h(c, out, runs)
    check_t(c, out, runs)
    check_m(c, out, runs)
    check_e(c, out, runs)

    # --- I1 (round 27 C1, limitation 21): the model writing Magic's folded tool
    # record as its own TEXT (old `[tool: read #call_N]` form, or the new
    # framed record). Model behaviour: WARN with the hits (the run that shows
    # it also fails its own scenario check, e.g. R9/R11 in 41769676548).
    imit = re.compile(r"(?m)^\s*\[tool( result)?: [\w.-]+ #|<recorded-tool-activity|^\s*- called [\w.-]+ \(id ")
    hits = []
    for p in sorted(out.glob("*.log")):
        for t in visible_texts(p):
            if imit.search(t or ""):
                hits.append({"run": p.stem, "chars": len(t), "head": (t or "")[:160]})
    c.add("I1", True if not hits else "warn",
          "no model TEXT imitates the folded tool record (limitation 21)", hits or "none")

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


def xsha(out: Path) -> int:
    """sha256 of every tool/result text in x-session.jsonl, raw and with each
    truncated tag's "§N§ " prefix (tags from the db-x-*.json dumps)."""
    texts = []
    for line in (out / "x-session.jsonl").read_text().splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "tool/result":
            for b in ((e.get("data") or {}).get("message") or {}).get("content") or []:
                if isinstance(b, dict) and isinstance(b.get("text"), str):
                    texts.append(b["text"])
    tags = set()
    for p in out.glob("db-x-*.json"):
        try:
            for r in json.loads(p.read_text()).get("truncations") or []:
                tags.add(r.get("tag_number"))
        except Exception:
            pass
    sha = lambda t: hashlib.sha256(t.encode()).hexdigest()
    print(json.dumps({"raw": [sha(t) for t in texts],
                      "prefixed": {str(n): [sha(f"\u00a7{n}\u00a7 {t}") for t in texts] for n in sorted(tags)}}))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("check", "redact", "xsha"):
        print(__doc__)
        sys.exit(2)
    d = Path(sys.argv[2])
    sys.exit(check(d) if sys.argv[1] == "check" else redact(d) if sys.argv[1] == "redact" else xsha(d))
