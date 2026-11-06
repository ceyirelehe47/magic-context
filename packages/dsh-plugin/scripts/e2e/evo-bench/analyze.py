#!/usr/bin/env python3
"""Round 36 line I evo bench analysis.

    analyze.py <out.md> <run-dir> [<run-dir> ...]    tables + <out.md>.json
    analyze.py --cost <run-dir>                       running cost (USD), for run.sh's cap

Per run (every proxied request counts, main agent + historian / summarizer + titles):
  pass rate (score/score.json), cost (cache-aware, DeepSeek flash peak list price,
  same table as cache-bench/analyze.py), input / cache-hit / miss / output /
  reasoning tokens, hit rate = Σhit / Σ(hit+miss), compactions, end-to-end time,
  failed turns.
Compactions are counted three ways: (a) compaction requests seen by the proxy
(plugin historian route "historian", DSH compaction-basic summarizer "other");
(b) session `compaction/start` events (DSH native compaction, also the plugin's
90 % backstop); (c) context-reduction boundaries: consecutive main-agent calls
whose prompt shrinks by >= 15 % (whatever caused it: native compaction, a
historian publish, a ctx_reduce drop). For (c) the hit rate (hit / prompt) of
the last call before and the first call after is reported, as in CompactionBench
Figure 5a.
"""
import json, os, re, sys, statistics as st

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cache-bench"))
from analyze import PRICE, PRICE_SRC, jl, hm, reasoning  # noqa: E402

DROP = 0.15
SUMMARIZER = "You are now acting as a compaction engine"
HISTORIAN = "You are Historian"  # Magic Context historian; with no historian.model it rides the main route  # DSH compaction-basic: same route, tools and system as the main agent
NET = re.compile(r"curl |wget |pip (download|install)|git (clone|fetch)|https?://")
# history probes: reading upstream history / a pristine image (smoke 42238241963: fold ran
# `docker run IMG git log 2.0.2..2.0.3` and applied the upstream commits)
HIST = re.compile(r"docker (run|pull|create|save|export|cp|history)\b|git (log|show|tag|rev-list|cat-file|reflog)\b")


def kinds(rd, reqs):
    """proxy kind, with DSH's compaction-basic summarizer split out of "main" (it reuses the main
    request shape, so the proxy cannot tell them apart; its last message is the compaction prompt).
    Read from bodies/ when present, cached in evo-kinds.json for runs whose bodies were packed."""
    cache = os.path.join(rd, "evo-kinds.json")
    bd = os.path.join(rd, "bodies")
    if os.path.isdir(bd):
        out = {}
        for r in reqs:
            k = r.get("kind")
            p = os.path.join(bd, f"{r['n']}.json")
            if k in ("main", "other") and os.path.exists(p):
                try:
                    msgs = json.load(open(p)).get("messages") or []
                    s0 = next((x.get("content") for x in msgs if x.get("role") in ("system", "developer")), "") or ""
                    s0 = s0 if isinstance(s0, str) else "".join(x.get("text", "") for x in s0 if isinstance(x, dict))
                    if HISTORIAN in s0[:400]:
                        out[str(r["n"])] = "historian"
                        continue
                    m = msgs[-1]
                    c = m.get("content")
                    c = c if isinstance(c, str) else "".join(x.get("text", "") for x in (c or []) if isinstance(x, dict))
                    if m.get("role") == "user" and c.lstrip().startswith(SUMMARIZER):
                        k = "summarizer"
                except Exception:
                    pass
            out[str(r["n"])] = k
        json.dump(out, open(cache, "w"))
        return out
    if os.path.exists(cache):
        return json.load(open(cache))
    return {str(r["n"]): r.get("kind") for r in reqs}


def net_attempts(rd, rx=None):
    rx = rx or NET
    n, ex = 0, []
    for f in sorted(os.listdir(rd)):
        if not (f.startswith("turn-") and f.endswith(".log")):
            continue
        for line in open(os.path.join(rd, f), errors="replace"):
            if '"type":"tool_call"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if (rx is NET and o.get("tool") in ("web_fetch", "web_search")) or (o.get("tool") == "bash" and rx.search(str((o.get("input") or {}).get("command", "")))):
                n += 1
                if len(ex) < 8:
                    ex.append(f"{f}: {o.get('tool')} {json.dumps(o.get('input'))[:160]}")
    return n, ex


MC_ODD = re.compile(r"error|fail|warn|retry|retrying|backoff|pending|stuck|timeout|timed out|abort|crash|exceed|lease|deferred|already", re.I)


def anomalies(rd, reqs, turns, sid):
    """Everything unusual in one run, for the real-environment issue list (evidence = file + line)."""
    A = {"turn_rc": {}, "turns_without_turn_end": [], "turn_end": {}, "http_status": {}, "finish": {},
         "tool_errors": 0, "tool_error_examples": [], "mc_lines": {}, "mc_examples": {}, "stderr_lines": {}, "stderr_examples": {},
         "session_ids": [], "session_resume_mismatch": [], "max_tokens_sent": {}, "hit_drops": []}
    for t in turns:
        if t.get("rc") != 0:
            A["turn_rc"][str(t["turn"])] = t.get("rc")
    for r in reqs:
        A["http_status"][str(r.get("status"))] = A["http_status"].get(str(r.get("status")), 0) + 1
        f = str(r.get("finish"))
        A["finish"][f] = A["finish"].get(f, 0) + 1
    for f in sorted(os.listdir(rd)):
        if not (f.startswith("turn-") and f.endswith(".log")):
            continue
        has_end = False
        for i, line in enumerate(open(os.path.join(rd, f), errors="replace"), 1):
            if line.startswith("{"):
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "status" and o.get("phase") == "turn_end":
                    has_end = True
                    k = (o.get("reason") or {}).get("kind", "?")
                    A["turn_end"].setdefault(k, []).append(f[5:7])
                elif o.get("type") == "tool_result" and o.get("status") not in ("completed", None):
                    A["tool_errors"] += 1
                    if len(A["tool_error_examples"]) < 6:
                        A["tool_error_examples"].append(f"{f}:{i} {str(o.get('result'))[:160]}")
                elif o.get("type") == "session":
                    A["session_ids"].append(o.get("sessionId"))
                    if sid and o.get("sessionId") != sid:
                        A["session_resume_mismatch"].append(f)
            elif line.startswith("[magic-context]"):
                if MC_ODD.search(line):
                    key = re.sub(r"\d+(\.\d+)?", "N", line.strip())[:140]
                    A["mc_lines"][key] = A["mc_lines"].get(key, 0) + 1
                    A["mc_examples"].setdefault(key, f"{f}:{i}")
            elif line.strip():
                key = re.sub(r"\d+(\.\d+)?", "N", line.strip())[:140]
                A["stderr_lines"][key] = A["stderr_lines"].get(key, 0) + 1
                A["stderr_examples"].setdefault(key, f"{f}:{i}")
        if not has_end:
            A["turns_without_turn_end"].append(f[5:7])
    bd = os.path.join(rd, "bodies")
    if os.path.isdir(bd):
        for r in reqs:
            p = os.path.join(bd, f"{r['n']}.json")
            try:
                b = json.load(open(p))
            except Exception:
                continue
            k = f"{r.get('kind')}:{b.get('max_tokens', b.get('max_completion_tokens'))}"
            A["max_tokens_sent"][k] = A["max_tokens_sent"].get(k, 0) + 1
        json.dump(A["max_tokens_sent"], open(os.path.join(rd, "evo-maxtokens.json"), "w"))
    elif os.path.exists(os.path.join(rd, "evo-maxtokens.json")):
        A["max_tokens_sent"] = json.load(open(os.path.join(rd, "evo-maxtokens.json")))
    # cache-hit collapse on a main call that is NOT a prompt reduction (same or larger prompt)
    main = [r for r in reqs if r.get("kind") == "main" and hm(r.get("usage"))[0]]
    for a, b in zip(main, main[1:]):
        pa, ha, _, _ = hm(a["usage"]); pb, hb, _, _ = hm(b["usage"])
        if pa and pb >= pa * (1 - DROP) and pb > 20000 and ha / pa > 0.8 and hb / pb < 0.5:
            A["hit_drops"].append({"req": b["n"], "prompt": pb, "hit_before": round(ha / pa, 3), "hit_after": round(hb / pb, 3), "gap_s": round(((b.get("t0") or 0) - (a.get("t1") or 0)) / 1000)})
    return A


def cost_of(h, m, o):
    return (h * PRICE["hit"] + m * PRICE["miss"] + o * PRICE["out"]) / 1e6


def sid_file(rd):
    try:
        return open(os.path.join(rd, "sid")).read().strip()
    except Exception:
        return None


def run_stats(rd, gold=None):
    meta = json.load(open(os.path.join(rd, "meta.json")))
    reqs = sorted(jl(os.path.join(rd, "requests.jsonl")), key=lambda r: r["n"])
    kd = kinds(rd, reqs)
    for r in reqs:
        r["kind"] = kd.get(str(r["n"]), r.get("kind"))
    turns = jl(os.path.join(rd, "turns.jsonl"))
    sess = jl(os.path.join(rd, "session.jsonl"))
    sc = {}
    p = os.path.join(rd, "score", "score.json")
    if os.path.exists(p):
        sc = json.load(open(p))
    gold_rate = None
    if gold and sc:
        # SWE-bench convention: only tests that pass with the gold patch in this environment count
        tj = json.load(open(os.path.join(rd, "tests.json"))) if os.path.exists(os.path.join(rd, "tests.json")) else None
        gbad = set(gold.get("f2p_failed", [])) | set(gold.get("p2p_failed", []))
        rbad = set(sc.get("f2p_failed", [])) | set(sc.get("p2p_failed", []))
        v1 = [t for t in (tj or {}).get("FAIL_TO_PASS", []) if t not in gbad]; v2 = [t for t in (tj or {}).get("PASS_TO_PASS", []) if t not in gbad]
        n1, n2 = len(v1), len(v2); f1 = sum(t not in rbad for t in v1); p1 = sum(t not in rbad for t in v2)
        gold_rate = {"pass_rate": (f1 + p1) / (n1 + n2) if n1 + n2 else None, "f2p": f"{f1}/{n1}", "p2p": f"{p1}/{n2}"}
    tot = {"input": 0, "hit": 0, "miss": 0, "out": 0, "reason": 0}
    bykind = {}
    for r in reqs:
        pt, h, m, o = hm(r.get("usage"))
        if pt is None:
            continue
        k = r.get("kind")
        b = bykind.setdefault(k, {"n": 0, "input": 0, "hit": 0, "miss": 0, "out": 0, "reason": 0})
        for d in (tot, b):
            d["input"] += pt; d["hit"] += h; d["miss"] += m; d["out"] += o; d["reason"] += reasoning(r.get("usage")) or 0
        b["n"] += 1
    for b in bykind.values():
        b["cost"] = cost_of(b["hit"], b["miss"], b["out"])
    main = [r for r in reqs if r.get("kind") == "main" and hm(r.get("usage"))[0]]
    bounds = []
    for a, b in zip(main, main[1:]):
        pa, ha, _, _ = hm(a["usage"]); pb, hb, _, _ = hm(b["usage"])
        if pa and pb < pa * (1 - DROP):
            bounds.append({"req_before": a["n"], "req_after": b["n"], "prompt_before": pa, "prompt_after": pb,
                           "hit_before": ha / pa, "hit_after": hb / pb if pb else None})
    comp_req = {k: sum(1 for r in reqs if r.get("kind") == k and r.get("status") == 200) for k in ("historian", "summarizer", "other")}
    na, nex = net_attempts(rd)
    hpn, hpex = net_attempts(rd, HIST)
    comp_ev = sum(1 for e in sess if e.get("type") == "compaction/start")
    turn_ms = sum(t.get("ms", 0) for t in turns)
    ends = {}
    for f in sorted(os.listdir(rd)):
        if f.startswith("turn-") and f.endswith(".log"):
            for line in open(os.path.join(rd, f), errors="replace"):
                if '"phase":"turn_end"' in line:
                    try:
                        k = json.loads(line)["reason"]["kind"]
                    except Exception:
                        k = "?"
                    ends[k] = ends.get(k, 0) + 1
    failed = [t["turn"] for t in turns if t.get("rc") != 0]
    peak = max((hm(r["usage"])[0] for r in main), default=0)
    return {
        "dir": rd, "group": meta["group"], "label": meta["label"], "stop": meta.get("stop"),
        "turns_planned": meta.get("turns_planned"), "turns_run": len(turns), "failed_turns": failed, "turn_end_reasons": ends,
        "pass_rate": sc.get("pass_rate"), "f2p": f"{sc.get('f2p_pass')}/{sc.get('f2p_total')}", "p2p": f"{sc.get('p2p_pass')}/{sc.get('p2p_total')}",
        "gold_valid": gold_rate, "score_parsed": sc.get("parsed_results"), "excluded_test_files": len(sc.get("excluded_test_files", [])), "source_files": len(sc.get("source_files", [])),
        "src_apply_rc": sc.get("src_apply_rc"),
        "requests": len(reqs), "main_calls": len(main), "http_errors": sum(1 for r in reqs if r.get("status") != 200),
        **{f"tok_{k}": v for k, v in tot.items()},
        "hit_rate": tot["hit"] / (tot["hit"] + tot["miss"]) if tot["hit"] + tot["miss"] else None,
        "cost": cost_of(tot["hit"], tot["miss"], tot["out"]), "by_kind": bykind,
        "compaction_requests": comp_req, "compaction_start_events": comp_ev,
        "boundaries": bounds, "net_attempts": na, "net_examples": nex, "history_probes": hpn, "history_examples": hpex, "peak_prompt": peak,
        "anomalies": anomalies(rd, reqs, turns, sid_file(rd)),
        "turn_time_s": turn_ms / 1000, "wall_s": ((meta.get("end") or 0) - meta["start"]) / 1000 if meta.get("end") else None,
    }


def fmt_mean(xs, f="{:.1f}"):
    xs = [x for x in xs if x is not None]
    if not xs:
        return "—"
    return f.format(st.mean(xs)) + (f" ({f.format(min(xs))}–{f.format(max(xs))})" if len(xs) > 1 else "")


def main():
    if sys.argv[1] == "--cost":
        rs = jl(os.path.join(sys.argv[2], "requests.jsonl"))
        h = m = o = 0
        for r in rs:
            pt, a, b, c = hm(r.get("usage"))
            if pt is not None:
                h += a; m += b; o += c
        print(f"{cost_of(h, m, o):.4f}")
        return
    out = sys.argv[1]
    args = sys.argv[2:]
    gold = None
    if args and args[0] == "--gold":
        gp = args[1]; args = args[2:]
        gold = json.load(open(gp)) if os.path.exists(gp) else None
    runs = [run_stats(d, gold) for d in args if os.path.exists(os.path.join(d, "meta.json"))]
    L = ["# Evo bench results (generated by evo-bench/analyze.py)", "",
         f"Prices: {PRICE_SRC}: hit ${PRICE['hit']}/M, miss ${PRICE['miss']}/M, output ${PRICE['out']}/M (peak). All proxied requests count (main + historian/summarizer + titles).", "",
         "## Per run", "",
         "| group | run | turns run / planned (failed) | pass rate | F2P | P2P | cost USD | input tok | hit tok | miss tok | output tok | reasoning tok | hit rate | compaction req (hist / summ / other) | net attempts | history probes | compaction/start | reduction boundaries | hit before → after (mean) | peak prompt | turn time min | stop |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in runs:
        b = r["boundaries"]
        ba = "—" if not b else f"{st.mean(x['hit_before'] for x in b)*100:.1f} % → {st.mean(x['hit_after'] for x in b if x['hit_after'] is not None)*100:.1f} %"
        pr = "—" if r["pass_rate"] is None else f"{r['pass_rate']*100:.1f} %"
        hr = "—" if r["hit_rate"] is None else f"{r['hit_rate']*100:.1f} %"
        L.append(f"| {r['group']} | {r['label']} | {r['turns_run']}/{r['turns_planned']} ({len(r['failed_turns'])}{': ' + ','.join(map(str, r['failed_turns'])) if r['failed_turns'] else ''}) | {pr} | {r['f2p']} | {r['p2p']} | {r['cost']:.4f} | {r['tok_input']} | {r['tok_hit']} | {r['tok_miss']} | {r['tok_out']} | {r['tok_reason']} | {hr} | {r['compaction_requests']['historian']} / {r['compaction_requests']['summarizer']} / {r['compaction_requests']['other']} | {r['net_attempts']} | {r.get('history_probes', 0)} | {r['compaction_start_events']} | {len(b)} | {ba} | {r['peak_prompt']} | {r['turn_time_s']/60:.1f} | {r['stop']} {r['turn_end_reasons']} |")
    if gold:
        L += ["", f"Gold-valid tests (pass with the gold patch here): F2P {gold['f2p_total'] - len(gold['f2p_failed'])}/{gold['f2p_total']}, P2P {gold['p2p_total'] - len(gold['p2p_failed'])}/{gold['p2p_total']}.", "",
              "| group | run | gold-valid pass rate | F2P | P2P |", "|---|---|---|---|---|"]
        for r in runs:
            g = r["gold_valid"] or {}
            L.append(f"| {r['group']} | {r['label']} | {'—' if g.get('pass_rate') is None else '%.1f %%' % (g['pass_rate'] * 100)} | {g.get('f2p')} | {g.get('p2p')} |")
    groups = {}
    for r in runs:
        groups.setdefault(r["group"], []).append(r)
    L += ["", "## Per group (mean (min–max))", "", "| group | runs | pass rate % | cost USD | hit rate % | input tok | output tok | reasoning tok | compactions (req+events) | boundaries | turn time min | failed turns |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for g in ("baseline", "fold", "native"):
        rs = groups.get(g)
        if not rs:
            continue
        L.append(f"| {g} | {len(rs)} | {fmt_mean([r['pass_rate'] and r['pass_rate']*100 for r in rs])} | {fmt_mean([r['cost'] for r in rs], '{:.3f}')} | {fmt_mean([r['hit_rate'] and r['hit_rate']*100 for r in rs])} | {fmt_mean([r['tok_input'] for r in rs], '{:.0f}')} | {fmt_mean([r['tok_out'] for r in rs], '{:.0f}')} | {fmt_mean([r['tok_reason'] for r in rs], '{:.0f}')} | {fmt_mean([sum(r['compaction_requests'].values()) + r['compaction_start_events'] for r in rs], '{:.0f}')} | {fmt_mean([len(r['boundaries']) for r in rs], '{:.0f}')} | {fmt_mean([r['turn_time_s']/60 for r in rs])} | {sum(len(r['failed_turns']) for r in rs)} |")
    L += ["", "## Cost by request kind", "", "| group | run | kind | n | input | hit | miss | out | cost USD |", "|---|---|---|---|---|---|---|---|---|"]
    for r in runs:
        for k, b in sorted(r["by_kind"].items(), key=lambda x: str(x[0])):
            L.append(f"| {r['group']} | {r['label']} | {k} | {b['n']} | {b['input']} | {b['hit']} | {b['miss']} | {b['out']} | {b['cost']:.4f} |")
    L += ["", "## Reduction boundaries (main-call prompt drop >= 15 %)", ""]
    for r in runs:
        for x in r["boundaries"]:
            L.append(f"- {r['group']} {r['label']}: req {x['req_before']}→{x['req_after']} prompt {x['prompt_before']}→{x['prompt_after']}, hit {x['hit_before']*100:.1f} % → {(x['hit_after'] or 0)*100:.1f} %")
    L += ["", "## Anomalies per run (raw material for the real-environment issue list; evidence = artifact file:line)", ""]
    for r in runs:
        A = r.get("anomalies") or {}
        L.append(f"### {r['group']} {r['label']}")
        L.append(f"- turn rc != 0: {A.get('turn_rc') or 'none'}; turns without turn_end: {A.get('turns_without_turn_end') or 'none'}; turn_end: { {k: len(v) for k, v in (A.get('turn_end') or {}).items()} } (max-tokens in turns {(A.get('turn_end') or {}).get('max-tokens', [])})")
        L.append(f"- proxy HTTP status: {A.get('http_status')}; finish reasons: {A.get('finish')}; max_tokens sent (kind:value → n): {A.get('max_tokens_sent') or 'n/a'}")
        L.append(f"- session ids seen: {len(set(A.get('session_ids') or []))} distinct over {len(A.get('session_ids') or [])} turns; resume mismatch: {A.get('session_resume_mismatch') or 'none'}")
        L.append(f"- tool errors: {A.get('tool_errors', 0)}" + ("".join(f"\n  - `{e}`" for e in A.get('tool_error_examples', []))))
        L.append(f"- cache-hit collapses without a prompt reduction (hit > 80 % → < 50 %): {len(A.get('hit_drops', []))}" + ("".join(f"\n  - req {d['req']} prompt {d['prompt']} hit {d['hit_before']} → {d['hit_after']} gap {d['gap_s']} s" for d in A.get('hit_drops', [])[:8])))
        mc = sorted((A.get('mc_lines') or {}).items(), key=lambda x: -x[1])
        L.append(f"- Magic Context log lines (warn / error / retry / pending / deferred …): {sum(v for _, v in mc)}" + "".join(f"\n  - {v}× `{k}` (first: {A['mc_examples'][k]})" for k, v in mc[:12]))
        se = sorted((A.get('stderr_lines') or {}).items(), key=lambda x: -x[1])
        L.append(f"- other non-JSON output lines: {sum(v for _, v in se)}" + "".join(f"\n  - {v}× `{k}` (first: {A['stderr_examples'][k]})" for k, v in se[:12]))
        L.append("")
    open(out, "w").write("\n".join(L) + "\n")
    json.dump({"price": PRICE, "runs": runs}, open(out + ".json", "w"), indent=1, default=str)
    print("\n".join(L[:20]))


if __name__ == "__main__":
    main()
