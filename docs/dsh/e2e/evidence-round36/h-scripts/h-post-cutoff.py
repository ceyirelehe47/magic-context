#!/usr/bin/env python3
"""Round 36 line H: main-request cost / hit after the bench cutoff (first historian request), per run.
Prices: hit $0.006/M, miss $0.3/M, out $1.2/M (summary.md, peak). Usage: post-cutoff.py <bench dir>..."""
import json, glob, os, sys
P = dict(hit=0.006e-6, miss=0.3e-6, out=1.2e-6)
for base in sys.argv[1:]:
    for rd in sorted(glob.glob(base + "/run*")):
        reqs = sorted([json.loads(l) for l in open(rd + "/requests.jsonl")], key=lambda q: q["t0"])
        fh = next((q["n"] for q in reqs if q["kind"] == "historian"), None)
        agg = {"pre": [0, 0, 0, 0, 0], "post": [0, 0, 0, 0, 0]}  # n, hit, miss, out, reasoning
        breaks = []; prev = None; red = 0
        for q in reqs:
            if q["kind"] != "main": continue
            u = q.get("usage") or {}
            p = u.get("prompt_tokens", 0); c = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
            o = u.get("completion_tokens", 0); r = (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
            seg = "post" if fh is not None and q["n"] > fh else "pre"
            a = agg[seg]; a[0] += 1; a[1] += c; a[2] += p - c; a[3] += o; a[4] += r
            if prev and c / prev < 0.5: breaks.append((q["n"], prev, p, c))
            prev = p
            try:
                x = json.load(open(f"{rd}/resp/{q['n']}.json"))
                red += sum(1 for t in x.get("tool_calls") or [] if t["name"] == "ctx_reduce")
            except Exception: pass
        out = []
        for seg, a in agg.items():
            cost = a[1] * P["hit"] + a[2] * P["miss"] + a[3] * P["out"]
            hr = a[1] / max(a[1] + a[2], 1)
            out.append(f"{seg}: n={a[0]} hit={hr:.3f} cost=${cost:.4f} cost/req=${cost/max(a[0],1):.5f} out/req={a[3]/max(a[0],1):.0f} reas/req={a[4]/max(a[0],1):.0f}")
        print(os.path.basename(base), os.path.basename(rd), "historian", fh, "ctx_reduce", red, " | ".join(out), "breaks(n,prev,prompt,cached)", breaks)
