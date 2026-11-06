# per-group per-step output/reasoning table (429 / no-usage steps excluded), runs given as rid[:mode]
import sys, json, glob, statistics as st
sys.path.insert(0, "packages/dsh-plugin/scripts/e2e/cache-bench")
import analyze
def q(xs):
    xs=sorted(xs); return f"{st.mean(xs):.0f} / {st.median(xs):.0f} / {xs[int(.9*(len(xs)-1))]}" if xs else "—"
print("| run | group (ablate) | runs | steps (usage) | out/step mean / median / p90 | reasoning/step mean / median / p90 | steps 1–14 out | steps 1–14 reasoning | steps 15+ out | steps 15+ reasoning | text (out−reasoning)/step | steps with reasoning=0 |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for spec in sys.argv[1:]:
    rid, _, only = spec.partition(":")
    groups={}
    for d in sorted(glob.glob(f"./art/{rid}/dsh-e2e-cachebench-*/run*")):
        r=analyze.run_stats(d); meta=json.load(open(d+"/meta.json"))
        if only and r["mode"]!=only: continue
        groups.setdefault((r["mode"],meta.get("ablate","")),[]).append(r)
    for (mode,ab),rs in groups.items():
        S=[[s for s in r["steps"] if s["completion_tokens"]] for r in rs]
        al=[s for x in S for s in x]; f=[s for x in S for s in x[:14]]; l=[s for x in S for s in x[14:]]
        O=lambda xs:[s["completion_tokens"] for s in xs]; R=lambda xs:[s["reasoning_tokens"] or 0 for s in xs]
        print(f"| {rid} | {mode}{' ('+ab+')' if ab else ''} | {len(rs)} | {len(al)} | {q(O(al))} | {q(R(al))} | {q(O(f))} | {q(R(f))} | {q(O(l))} | {q(R(l))} | {st.mean([a-b for a,b in zip(O(al),R(al))]):.0f} | {sum(1 for x in R(al) if x==0)}/{len(al)} |")
