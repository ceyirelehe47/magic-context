#!/usr/bin/env python3
"""c-drop-gate-post.py <run-root> (round 36 line C; reads dsh-cache-bench artifacts) [...] -> per plugin run: every main request over the WHOLE run (not only before the
cutoff): prefix vs previous main request, [dropped §N§] count in the body, hit/miss; ctx_reduce calls
(session.jsonl tool/call time; the first main request after it is the
step that carries the call — DSH folds tool calls into Magic's recorded-activity text, so bodies have no tool_calls); for each ctx_reduce: steps until the
dropped count rises (landing), whether all steps in between are append-only, how many placeholders
landed in that one step, and whether later steps (without a new ctx_reduce) add more.
Non-main proxy requests (historian/other/title) are listed as events so the ride can be read."""
import glob, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../packages/dsh-plugin/scripts/e2e/cache-bench"))
import analyze as A

def body(rd, n):
    p = os.path.join(rd, "bodies", f"{n}.json")
    return json.load(open(p)) if os.path.exists(p) else None

def ctx_ids(b):
    out = []
    for m in (b or {}).get("messages") or []:
        for tc in m.get("tool_calls") or []:
            if ((tc.get("function") or {}).get("name")) == "ctx_reduce":
                out.append(tc.get("id") or json.dumps(tc)[:80])
    return out

def run(rd):
    meta = json.load(open(os.path.join(rd, "meta.json")))
    reqs = sorted(A.jl(os.path.join(rd, "requests.jsonl")), key=lambda r: r["n"])
    sess = A.jl(os.path.join(rd, "session.jsonl"))
    cut_req = next((r for r in reqs if r.get("kind") in ("historian", "other")), None)
    cut_ses = next((e for e in sess if e.get("type") == "compaction/start"), None)
    cands = [x for x in [cut_req and cut_req["t0"], cut_ses and cut_ses.get("time")] if x]
    cutoff = min(cands) if cands else None
    cr_times = [e.get("time") for e in sess if e.get("type") == "tool/call" and (e.get("data") or {}).get("name") == "ctx_reduce"]
    cr_args = [(e.get("data") or {}).get("arguments") for e in sess if e.get("type") == "tool/call" and (e.get("data") or {}).get("name") == "ctx_reduce"]
    comp = [e.get("time") for e in sess if e.get("type") == "compaction/start"]
    rows, prev, seen = [], None, set()
    for r in reqs:
        if r.get("kind") != "main":
            rows.append({"n": r["n"], "event": r.get("kind"), "t0": r["t0"]})
            continue
        b = body(rd, r["n"])
        pt, h, m, o = A.hm(r.get("usage"))
        d = A.divergence(prev, b)
        new = [t for t in cr_times if t not in seen and t < r["t0"]]; seen.update(new)
        txt = A.canon((b or {}).get("messages") or [])
        rows.append({"n": r["n"], "t0": r["t0"], "after_cutoff": bool(cutoff and r["t0"] >= cutoff),
                     "prompt": pt, "hit": h, "miss": m, "out": o,
                     "div": None if d is None else ("append" if d["append_only"] else d.get("where")),
                     "dropped": len(re.findall(r"\[dropped §\d+§\]", txt)), "new_ctx_reduce": len(new)})
        if b is not None:
            prev = b
    mains = [x for x in rows if "event" not in x]
    for i, x in enumerate(mains):
        x["step"] = i + 1
    # compaction starts as events
    for t in comp:
        rows.append({"event": "session compaction/start", "t0": t})
    rows.sort(key=lambda x: x["t0"])
    episodes = []
    for i, x in enumerate(mains):
        if not x["new_ctx_reduce"]:
            continue
        base = x["dropped"]; land = None; between = []
        for y in mains[i + 1:]:
            if y["dropped"] > base:
                land = y; break
            between.append(y)
        ep = {"ctx_reduce_step": x["step"], "n": x["n"], "after_cutoff": x["after_cutoff"], "steps_waiting": len(between),
              "waiting_all_append": all(y["div"] == "append" for y in between),
              "waiting_divs": sorted({str(y["div"]) for y in between}),
              "waiting_hit_rate": (lambda H, M: H / (H + M) if H + M else None)(sum(y["hit"] or 0 for y in between), sum(y["miss"] or 0 for y in between))}
        if land:
            j = mains.index(land)
            ev = [r for r in rows if "event" in r and mains[j - 1]["t0"] < r["t0"] <= land["t0"]]
            after = mains[j + 1:]
            nxt_cr = next((k for k, y in enumerate(after) if y["new_ctx_reduce"]), len(after))
            later = after[:nxt_cr]
            ep |= {"land_step": land["step"], "land_n": land["n"], "land_after_cutoff": land["after_cutoff"],
                   "landed": land["dropped"] - base, "land_div": land["div"], "land_hit": land["hit"], "land_miss": land["miss"],
                   "events_before_land": [e["event"] for e in ev],
                   "later_steps_until_next_ctx_reduce": len(later),
                   "later_more_drops": any(y["dropped"] > land["dropped"] for y in later),
                   "later_divs": sorted({str(y["div"]) for y in later})}
        episodes.append(ep)
    return {"mode": meta["mode"], "label": meta["label"], "stop": meta.get("stop"), "main_steps": len(mains),
            "cutoff_step": next((x["step"] for x in mains if x["after_cutoff"]), None),
            "ctx_reduce_args": cr_args, "episodes": episodes, "rows": rows}

out = {}
for root in sys.argv[1:]:
    out[root] = [run(d) for d in sorted(glob.glob(f"{root}/dsh-e2e-cachebench-plugin-*/run*"))]
print(json.dumps(out, indent=1, default=str))
