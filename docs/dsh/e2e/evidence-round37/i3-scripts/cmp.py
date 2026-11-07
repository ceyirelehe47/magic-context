#!/usr/bin/env python3
"""Round 37: per-request comparison of evo runs (local analysis, not committed as product).

    cmp.py <out.md> <run-dir> [...]

Per run, main-session requests only (kind from evo-kinds.json / analyze.kinds; subagent,
historian, summarizer, title counted separately):
  - request structure: share of main requests carrying a historical assistant message,
    a tool message, native tool_calls, reasoning_content (first request excluded);
  - reasoning tokens per request: n with usage, median, p90, max, sum; requests without usage;
  - duration per request (t1 - t0 ms): median, p90;
  - output tokens / output cost (reasoning is a subset of completion tokens, not added);
  - HTTP non-200, finish reasons;
  - repeated identical tool calls (same name + arguments) in main responses.
"""
import json, os, statistics as st, sys
import importlib.util
_spec = importlib.util.spec_from_file_location("evo_analyze", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "..", "packages", "dsh-plugin", "scripts", "e2e", "evo-bench", "analyze.py"))
evo = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(evo)
jl, hm, reasoning = evo.jl, evo.hm, evo.reasoning

OUT_PRICE = evo.PRICE["out"]


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


def structure(body):
    msgs = body.get("messages") or []
    a = any(m.get("role") == "assistant" for m in msgs)
    t = any(m.get("role") == "tool" for m in msgs)
    tc = any(m.get("role") == "assistant" and m.get("tool_calls") for m in msgs)
    rc = any(m.get("role") == "assistant" and m.get("reasoning_content") for m in msgs)
    return a, t, tc, rc


def run(rd):
    meta = json.load(open(os.path.join(rd, "meta.json")))
    reqs = sorted(jl(os.path.join(rd, "requests.jsonl")), key=lambda r: r["n"])
    kd = evo.kinds(rd, reqs)
    for r in reqs:
        r["kind"] = kd.get(str(r["n"]), r.get("kind"))
    main = [r for r in reqs if r.get("kind") == "main"]
    mainn = {r["n"] for r in main}
    st_counts = [0, 0, 0, 0]
    nb = 0
    first = min(mainn) if mainn else None
    for n, body in evo._iter_bodies(rd):
        if n not in mainn or n == first:
            continue
        nb += 1
        for i, v in enumerate(structure(body)):
            st_counts[i] += v
    rs = [reasoning(r.get("usage")) for r in main if hm(r.get("usage"))[0] is not None]
    rs = [x or 0 for x in rs]
    ms = [r["t1"] - r["t0"] for r in main if r.get("t1") and r.get("t0")]
    out = sum(hm(r.get("usage"))[3] or 0 for r in main if hm(r.get("usage"))[0] is not None)
    nousage = sum(1 for r in main if hm(r.get("usage"))[0] is None)
    non200 = sum(1 for r in reqs if r.get("status") != 200)
    fin = {}
    for r in main:
        fin[r.get("finish")] = fin.get(r.get("finish"), 0) + 1
    # repeated tool calls in main responses
    seen, rep, calls = {}, 0, 0
    for r in main:
        p = os.path.join(rd, "resp", f"{r['n']}.json")
        if not os.path.exists(p):
            continue
        try:
            rr = json.load(open(p))
        except Exception:
            continue
        for c in rr.get("tool_calls") or []:
            if not c:
                continue
            f = c.get("function") or c
            key = (f.get("name"), f.get("arguments"))
            calls += 1
            if key in seen:
                rep += 1
            seen[key] = 1
    kinds = {}
    for r in reqs:
        k = r.get("kind")
        b = kinds.setdefault(k, {"n": 0, "ok": 0, "reason": 0, "out": 0})
        b["n"] += 1
        if hm(r.get("usage"))[0] is not None:
            b["ok"] += 1
            b["reason"] += reasoning(r.get("usage")) or 0
            b["out"] += hm(r.get("usage"))[3] or 0
    turns = jl(os.path.join(rd, "turns.jsonl"))
    return {
        "group": meta["group"], "label": meta["label"], "native_roles": meta.get("native_roles"), "stop": meta.get("stop"),
        "turns": f"{sum(1 for t in turns if t.get('rc') == 0)}/{len(turns)}/{meta.get('turns_planned')}",
        "turn_rc": [t.get("rc") for t in turns], "turn_s": [round(t.get("ms", 0) / 1000) for t in turns],
        "main": len(main), "bodies": nb, "with_assistant": st_counts[0], "with_tool": st_counts[1], "with_tool_calls": st_counts[2], "with_reasoning_content": st_counts[3],
        "reason_n": len(rs), "reason_med": st.median(rs) if rs else None, "reason_p90": pct(rs, 0.9), "reason_max": max(rs) if rs else None, "reason_sum": sum(rs),
        "no_usage": nousage, "ms_med": st.median(ms) if ms else None, "ms_p90": pct(ms, 0.9),
        "out_tok": out, "out_cost": out * OUT_PRICE / 1e6, "non200": non200, "finish": fin,
        "tool_calls": calls, "repeated_calls": rep, "kinds": kinds,
        "files": [t.get("cum_files") for t in turns],
    }


def main():
    out = sys.argv[1]
    R = [run(d) for d in sys.argv[2:]]
    L = ["| group | run | native_roles env | turns ok/started/planned | turn rc | turn s | main req | hist. assistant / tool / tool_calls / reasoning_content (of bodies) | reasoning med / p90 / max | reasoning sum | main w/o usage | req ms med / p90 | main output tok | main output USD | non-200 | tool calls (repeated) | cum files | stop |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in R:
        L.append(f"| {r['group']} | {r['label']} | {r['native_roles']!r} | {r['turns']} | {r['turn_rc']} | {r['turn_s']} | {r['main']} | {r['with_assistant']} / {r['with_tool']} / {r['with_tool_calls']} / {r['with_reasoning_content']} (of {r['bodies']}) | {r['reason_med']} / {r['reason_p90']} / {r['reason_max']} | {r['reason_sum']} | {r['no_usage']} | {r['ms_med']} / {r['ms_p90']} | {r['out_tok']} | {r['out_cost']:.4f} | {r['non200']} | {r['tool_calls']} ({r['repeated_calls']}) | {r['files']} | {r['stop']} |")
    L.append("")
    for r in R:
        L.append(f"- {r['group']} {r['label']} kinds: " + ", ".join(f"{k}: n {v['n']} (usage {v['ok']}), reasoning {v['reason']}, out {v['out']}" for k, v in sorted(r['kinds'].items(), key=lambda x: str(x[0]))) + f"; finish {r['finish']}")
    open(out, "w").write("\n".join(L) + "\n")
    json.dump(R, open(out + ".json", "w"), indent=1, default=str)
    print("\n".join(L))


if __name__ == "__main__":
    main()
