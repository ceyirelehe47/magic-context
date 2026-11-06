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
import json, os, sys, statistics as st

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cache-bench"))
from analyze import PRICE, PRICE_SRC, jl, hm, reasoning  # noqa: E402

DROP = 0.15


def cost_of(h, m, o):
    return (h * PRICE["hit"] + m * PRICE["miss"] + o * PRICE["out"]) / 1e6


def run_stats(rd):
    meta = json.load(open(os.path.join(rd, "meta.json")))
    reqs = sorted(jl(os.path.join(rd, "requests.jsonl")), key=lambda r: r["n"])
    turns = jl(os.path.join(rd, "turns.jsonl"))
    sess = jl(os.path.join(rd, "session.jsonl"))
    sc = {}
    p = os.path.join(rd, "score", "score.json")
    if os.path.exists(p):
        sc = json.load(open(p))
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
    comp_req = {k: sum(1 for r in reqs if r.get("kind") == k and r.get("status") == 200) for k in ("historian", "other")}
    comp_ev = sum(1 for e in sess if e.get("type") == "compaction/start")
    turn_ms = sum(t.get("ms", 0) for t in turns)
    failed = [t["turn"] for t in turns if t.get("rc") != 0]
    peak = max((hm(r["usage"])[0] for r in main), default=0)
    return {
        "dir": rd, "group": meta["group"], "label": meta["label"], "stop": meta.get("stop"),
        "turns_planned": meta.get("turns_planned"), "turns_run": len(turns), "failed_turns": failed,
        "pass_rate": sc.get("pass_rate"), "f2p": f"{sc.get('f2p_pass')}/{sc.get('f2p_total')}", "p2p": f"{sc.get('p2p_pass')}/{sc.get('p2p_total')}",
        "score_parsed": sc.get("parsed_results"), "excluded_test_files": len(sc.get("excluded_test_files", [])), "source_files": len(sc.get("source_files", [])),
        "src_apply_rc": sc.get("src_apply_rc"),
        "requests": len(reqs), "main_calls": len(main), "http_errors": sum(1 for r in reqs if r.get("status") != 200),
        **{f"tok_{k}": v for k, v in tot.items()},
        "hit_rate": tot["hit"] / (tot["hit"] + tot["miss"]) if tot["hit"] + tot["miss"] else None,
        "cost": cost_of(tot["hit"], tot["miss"], tot["out"]), "by_kind": bykind,
        "compaction_requests": comp_req, "compaction_start_events": comp_ev,
        "boundaries": bounds, "peak_prompt": peak,
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
    runs = [run_stats(d) for d in sys.argv[2:] if os.path.exists(os.path.join(d, "meta.json"))]
    L = ["# Evo bench results (generated by evo-bench/analyze.py)", "",
         f"Prices: {PRICE_SRC}: hit ${PRICE['hit']}/M, miss ${PRICE['miss']}/M, output ${PRICE['out']}/M (peak). All proxied requests count (main + historian/summarizer + titles).", "",
         "## Per run", "",
         "| group | run | turns run / planned (failed) | pass rate | F2P | P2P | cost USD | input tok | hit tok | miss tok | output tok | reasoning tok | hit rate | compaction req (hist / other) | compaction/start | reduction boundaries | hit before → after (mean) | peak prompt | turn time min | stop |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in runs:
        b = r["boundaries"]
        ba = "—" if not b else f"{st.mean(x['hit_before'] for x in b)*100:.1f} % → {st.mean(x['hit_after'] for x in b if x['hit_after'] is not None)*100:.1f} %"
        pr = "—" if r["pass_rate"] is None else f"{r['pass_rate']*100:.1f} %"
        hr = "—" if r["hit_rate"] is None else f"{r['hit_rate']*100:.1f} %"
        L.append(f"| {r['group']} | {r['label']} | {r['turns_run']}/{r['turns_planned']} ({len(r['failed_turns'])}{': ' + ','.join(map(str, r['failed_turns'])) if r['failed_turns'] else ''}) | {pr} | {r['f2p']} | {r['p2p']} | {r['cost']:.4f} | {r['tok_input']} | {r['tok_hit']} | {r['tok_miss']} | {r['tok_out']} | {r['tok_reason']} | {hr} | {r['compaction_requests']['historian']} / {r['compaction_requests']['other']} | {r['compaction_start_events']} | {len(b)} | {ba} | {r['peak_prompt']} | {r['turn_time_s']/60:.1f} | {r['stop']} |")
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
    open(out, "w").write("\n".join(L) + "\n")
    json.dump({"price": PRICE, "runs": runs}, open(out + ".json", "w"), indent=1, default=str)
    print("\n".join(L[:20]))


if __name__ == "__main__":
    main()
