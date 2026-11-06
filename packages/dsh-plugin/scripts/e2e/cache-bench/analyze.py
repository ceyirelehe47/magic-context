#!/usr/bin/env python3
"""Round 36 cache bench analysis.

    analyze.py <out.md> <run-dir> [<run-dir> ...]

Each run dir is one bench.sh run (meta.json, requests.jsonl, bodies/, session.jsonl).
Per run: the main-agent model calls (proxy kind "main") made BEFORE the first
compaction started are the steps. Cutoff = min(t0 of the first historian /
"other" proxy request, time of the first session `compaction/start`).
hit/miss come from the provider's raw usage (prompt_cache_hit_tokens /
prompt_cache_miss_tokens, else prompt_tokens_details.cached_tokens).
Prefix divergence: for consecutive steps, the first message index whose JSON
differs (tools compared too) and the common-prefix share of the previous
request's serialization. Also writes <out.md>.json (machine-readable).
"""
import json, os, sys, statistics as st

PRICE = {"hit": 0.006, "miss": 0.30, "out": 1.20}  # USD / 1M tokens, deepseek-flash PEAK (off-peak = half)
PRICE_SRC = "https://api-docs.deepseek.com/quick_start/pricing (deepseek-flash = DeepSeek-V4.1-Flash-1017; fetched 2026-11-06)"


def jl(p):
    out = []
    if not os.path.exists(p):
        return out
    for line in open(p, errors="replace"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def hm(u):
    if not u:
        return None, None, None, None
    pt = u.get("prompt_tokens")
    if "prompt_cache_hit_tokens" in u or "prompt_cache_miss_tokens" in u:
        h = u.get("prompt_cache_hit_tokens") or 0
        m = u.get("prompt_cache_miss_tokens") or 0
    else:
        h = ((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0
        m = (pt or 0) - h
    if pt is None:
        pt = h + m
    return pt, h, m, u.get("completion_tokens") or 0


def reasoning(u):
    return ((u or {}).get("completion_tokens_details") or {}).get("reasoning_tokens")


def list_cost(u):
    return ((u or {}).get("opencode") or {}).get("list_cost")


def canon(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False)


def msg_label(m):
    c = m.get("content")
    if isinstance(c, list):
        c = "".join(p.get("text", "") if isinstance(p, dict) else "" for p in c)
    c = (c or "").replace("\n", " ")
    extra = " +tool_calls" if m.get("tool_calls") else ""
    return f"{m.get('role')}{extra}: {c[:90]}".replace("`", "'").replace("|", "/")


def divergence(prev, cur):
    if prev is None or cur is None:
        return None
    d = {}
    d["tools_same"] = canon(prev.get("tools")) == canon(cur.get("tools"))
    pm, cm = prev.get("messages") or [], cur.get("messages") or []
    i = 0
    while i < len(pm) and i < len(cm) and canon(pm[i]) == canon(cm[i]):
        i += 1
    d["prev_msgs"], d["cur_msgs"], d["first_diff_msg"] = len(pm), len(cm), i
    d["append_only"] = d["tools_same"] and i == len(pm)
    ps = canon(prev.get("tools")) + "".join(canon(m) for m in pm)
    cs = canon(cur.get("tools")) + "".join(canon(m) for m in cm)
    k, lim = 0, min(len(ps), len(cs))
    while k < lim and ps[k] == cs[k]:
        k += 1
    d["common_chars"], d["prev_chars"] = k, len(ps)
    if not d["append_only"]:
        if not d["tools_same"]:
            d["where"] = "tools"
        elif i < len(pm):
            d["where"] = f"msg[{i}]"
            d["prev_at"] = msg_label(pm[i])
            d["cur_at"] = msg_label(cm[i]) if i < len(cm) else "(missing)"
    return d


def run_stats(rd):
    meta = json.load(open(os.path.join(rd, "meta.json")))
    reqs = sorted(jl(os.path.join(rd, "requests.jsonl")), key=lambda r: r["n"])
    sess = jl(os.path.join(rd, "session.jsonl"))
    cut_req = next((r for r in reqs if r.get("kind") in ("historian", "other")), None)
    cut_ses = next((e for e in sess if e.get("type") == "compaction/start"), None)
    cands = [x for x in [cut_req and cut_req["t0"], cut_ses and cut_ses.get("time")] if x]
    cutoff = min(cands) if cands else None
    if cut_req and cutoff == cut_req["t0"]:
        cutoff_by = f"{cut_req.get('kind')} request"
    elif cut_ses:
        cutoff_by = "session compaction/start"
    else:
        cutoff_by = None
    steps, prev_body = [], None
    for r in reqs:
        if r.get("kind") != "main":
            continue
        if cutoff is not None and r["t0"] >= cutoff:
            break
        pt, h, m, o = hm(r.get("usage"))
        bp = os.path.join(rd, "bodies", f"{r['n']}.json")
        body = json.load(open(bp)) if os.path.exists(bp) else None
        s = {"step": len(steps) + 1, "req": r["n"], "status": r.get("status"), "prompt_tokens": pt, "cache_hit": h,
             "cache_miss": m, "completion_tokens": o, "reasoning_tokens": reasoning(r.get("usage")), "list_cost": list_cost(r.get("usage")), "ms": r.get("ms"), "nonced": r.get("nonced"),
             "prev_prompt_tokens": steps[-1]["prompt_tokens"] if steps else None,
             "div": divergence(prev_body, body)}
        steps.append(s)
        prev_body = body
    ok = [s for s in steps if s["cache_hit"] is not None]
    H = sum(s["cache_hit"] for s in ok); M = sum(s["cache_miss"] for s in ok); O = sum(s["completion_tokens"] for s in ok)
    H2 = sum(s["cache_hit"] for s in ok[1:]); M2 = sum(s["cache_miss"] for s in ok[1:])
    cost = (H * PRICE["hit"] + M * PRICE["miss"] + O * PRICE["out"]) / 1e6
    return {
        "dir": os.path.basename(rd.rstrip("/")), "mode": meta["mode"], "label": meta["label"], "stop": meta.get("stop"),
        "cutoff_by": cutoff_by,
        "cutoff_kinds": sorted({str(r.get("kind")) for r in reqs if cutoff and r["t0"] >= cutoff}),
        "steps": steps, "n_steps": len(steps), "n_usage": len(ok),
        "hit": H, "miss": M, "out": O, "rate": H / (H + M) if H + M else None,
        "rate_after1": H2 / (H2 + M2) if H2 + M2 else None,
        "step1_hit": ok[0]["cache_hit"] if ok else None,
        "last_prompt_tokens": steps[-1]["prompt_tokens"] if steps else None,
        "cost_usd_peak": cost,
        "cost_parts": {"hit": H * PRICE["hit"] / 1e6, "miss": M * PRICE["miss"] / 1e6, "out": O * PRICE["out"] / 1e6},
        "cost_per_step": cost / len(ok) if ok else None,
        "out_per_step": O / len(ok) if ok else None,
        "reasoning_per_step": (sum(s["reasoning_tokens"] or 0 for s in ok) / len(ok)) if ok else None,
        "opencode_list_cost": sum(s["list_cost"] or 0 for s in ok),
        "n_append_only": sum(1 for s in steps[1:] if s["div"] and s["div"]["append_only"]),
        "n_diverged": sum(1 for s in steps[1:] if s["div"] and not s["div"]["append_only"]),
        "titles": sum(1 for r in reqs if r.get("kind") == "title"),
        "raw_usage_keys": sorted({k for r in reqs if r.get("usage") for k in r["usage"]}),
    }


def agg(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return {"mean": st.mean(xs), "min": min(xs), "max": max(xs), "n": len(xs)}


def pct(a):
    return "—" if a is None else f"{a['mean']*100:.1f} % ({a['min']*100:.1f}–{a['max']*100:.1f})"


def num(a, f="{:.0f}"):
    return "—" if a is None else f"{f.format(a['mean'])} ({f.format(a['min'])}–{f.format(a['max'])})"


def main():
    out = sys.argv[1]
    runs = [run_stats(d) for d in sys.argv[2:]]
    L = ["# Cache bench results (generated by analyze.py)", "",
         f"Prices: {PRICE_SRC}: cache hit ${PRICE['hit']}/M, miss ${PRICE['miss']}/M, output ${PRICE['out']}/M (peak; off-peak is half, ratios unchanged).", ""]
    groups = {}
    for r in runs:
        groups.setdefault(r["mode"], []).append(r)
    L += ["## Summary", "",
          "| group | runs | hit rate Σhit/Σ(hit+miss) mean (min–max) | after step 1 | step-1 hit tokens | steps to 1st compaction | prompt tokens at last step | cost/run USD (peak) | append-only / diverged steps |",
          "|---|---|---|---|---|---|---|---|---|"]
    summ = {}
    for g, rs in sorted(groups.items()):
        a = {k: agg([r[k] for r in rs]) for k in ("rate", "rate_after1", "n_steps", "last_prompt_tokens", "cost_usd_peak", "step1_hit", "cost_per_step", "out_per_step", "reasoning_per_step", "opencode_list_cost")}
        a["cost_parts"] = {k: agg([r["cost_parts"][k] for r in rs]) for k in ("hit", "miss", "out")}
        summ[g] = a
        L.append(f"| {g} | {len(rs)} | {pct(a['rate'])} | {pct(a['rate_after1'])} | {num(a['step1_hit'])} | {num(a['n_steps'], '{:.1f}')} | {num(a['last_prompt_tokens'])} | {num(a['cost_usd_peak'], '{:.4f}')} | {sum(r['n_append_only'] for r in rs)} / {sum(r['n_diverged'] for r in rs)} |")
    L += ["", "| group | cost/step USD (peak) | cost parts per run: hit / miss / output USD | output tokens/step | reasoning tokens/step | OpenCode list_cost per run USD |", "|---|---|---|---|---|---|"]
    for g, rs in sorted(groups.items()):
        a = summ[g]
        cp = a["cost_parts"]
        L.append(f"| {g} | {num(a['cost_per_step'], '{:.5f}')} | {cp['hit']['mean']:.4f} / {cp['miss']['mean']:.4f} / {cp['out']['mean']:.4f} | {num(a['out_per_step'], '{:.0f}')} | {num(a['reasoning_per_step'], '{:.0f}')} | {num(a['opencode_list_cost'], '{:.4f}')} |")
    nmin = min((r["n_usage"] for r in runs), default=0)
    if nmin:
        L += ["", f"### Common window (first {nmin} steps of every run)", "", "| group | hit rate mean (min–max) | after step 1 | cost/run USD (peak) |", "|---|---|---|---|"]
        for g, rs in sorted(groups.items()):
            rr, rr2, cc = [], [], []
            for r in rs:
                s = [x for x in r["steps"] if x["cache_hit"] is not None][:nmin]
                h = sum(x["cache_hit"] for x in s); m = sum(x["cache_miss"] for x in s); o = sum(x["completion_tokens"] for x in s)
                h2 = sum(x["cache_hit"] for x in s[1:]); m2 = sum(x["cache_miss"] for x in s[1:])
                rr.append(h / (h + m) if h + m else None); rr2.append(h2 / (h2 + m2) if h2 + m2 else None)
                cc.append((h * PRICE["hit"] + m * PRICE["miss"] + o * PRICE["out"]) / 1e6)
            L.append(f"| {g} | {pct(agg(rr))} | {pct(agg(rr2))} | {num(agg(cc), '{:.4f}')} |")
            summ.setdefault(g, {})["common"] = {"n": nmin, "rate": agg(rr), "rate_after1": agg(rr2), "cost": agg(cc)}
    L += ["", "## Runs", ""]
    for r in runs:
        rate = "—" if r["rate"] is None else "%.1f %%" % (r["rate"] * 100)
        rate2 = "—" if r["rate_after1"] is None else "%.1f %%" % (r["rate_after1"] * 100)
        L += [f"### {r['mode']} {r['label']} (stop {r['stop']}; cutoff by {r['cutoff_by']}; requests from cutoff on: {', '.join(r['cutoff_kinds']) or '—'})", "",
              f"steps {r['n_steps']} · hit {r['hit']} · miss {r['miss']} · out {r['out']} · rate {rate} · after step 1 {rate2} · cost ${r['cost_usd_peak']:.4f} · raw usage keys: {', '.join(r['raw_usage_keys'])}", "",
              "| step | prompt_tokens | cache_hit | cache_miss | hit / prev prompt | out (reasoning) | ms | prefix vs previous step |", "|---|---|---|---|---|---|---|---|"]
        for s in r["steps"]:
            d = s["div"]
            dv = "—" if d is None else ("append-only" if d["append_only"] else f"diverges at {d.get('where')} ({d['common_chars']}/{d['prev_chars']} chars common)")
            hp = f"{s['cache_hit']/s['prev_prompt_tokens']:.2f}" if s["prev_prompt_tokens"] and s["cache_hit"] is not None else "—"
            L.append(f"| {s['step']} | {s['prompt_tokens']} | {s['cache_hit']} | {s['cache_miss']} | {hp} | {s['completion_tokens']} ({s['reasoning_tokens']}) | {s['ms']} | {dv} |")
        divs = [s for s in r["steps"] if s["div"] and not s["div"]["append_only"]]
        if divs:
            L += ["", "First divergences (previous → current message at the first differing index):", ""]
            for s in divs[:12]:
                d = s["div"]
                L.append(f"- step {s['step']} {d.get('where')}: `{d.get('prev_at', '')}` → `{d.get('cur_at', '')}`")
        L.append("")
    open(out, "w").write("\n".join(L) + "\n")
    json.dump({"price": PRICE, "price_src": PRICE_SRC, "summary": summ, "runs": runs}, open(out + ".json", "w"), indent=1, default=str)
    print("\n".join(L[:30]))


if __name__ == "__main__":
    main()
