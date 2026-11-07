#!/usr/bin/env python3
"""Round 37 segment 2: per-kind stats (main / subagent / historian / summarizer / title) per run,
pooled per group, plus first-main-request equality after nonce / workdir normalisation.

    pair.py <out.md> <run-dir> [...]
"""
import json, os, re, sys, statistics as st, hashlib
import importlib.util
_spec = importlib.util.spec_from_file_location("evo_analyze", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "..", "packages", "dsh-plugin", "scripts", "e2e", "evo-bench", "analyze.py"))
evo = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(evo)
jl, hm, reasoning, cost_of = evo.jl, evo.hm, evo.reasoning, evo.cost_of


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


def load(rd):
    meta = json.load(open(os.path.join(rd, "meta.json")))
    reqs = sorted(jl(os.path.join(rd, "requests.jsonl")), key=lambda r: r["n"])
    kd = evo.kinds(rd, reqs)
    for r in reqs:
        r["kind"] = kd.get(str(r["n"]), r.get("kind"))
    turns = jl(os.path.join(rd, "turns.jsonl"))
    return meta, reqs, turns


def kstats(rs):
    ok = [r for r in rs if hm(r.get("usage"))[0] is not None]
    rz = [reasoning(r.get("usage")) or 0 for r in ok]
    ms = [r["t1"] - r["t0"] for r in rs if r.get("t1") and r.get("t0")]
    cost = 0.0
    out = 0
    for r in ok:
        i, h, m, o = hm(r.get("usage"))
        cost += cost_of(h or 0, m or 0, o or 0)
        out += o or 0
    st_ = {}
    for r in rs:
        st_[str(r.get("status"))] = st_.get(str(r.get("status")), 0) + 1
    return {
        "n": len(rs), "usage": len(ok), "no_usage": len(rs) - len(ok),
        "r_med": st.median(rz) if rz else None, "r_p90": pct(rz, 0.9), "r_max": max(rz) if rz else None, "r_sum": sum(rz),
        "ms_med": st.median(ms) if ms else None, "ms_p90": pct(ms, 0.9),
        "out": out, "cost": cost, "status": st_,
        "n429": sum(1 for r in rs if r.get("status") == 429),
        "http_err": sum(1 for r in rs if r.get("status") not in (200, 429)),
    }


def norm_first(rd, meta, reqs):
    main = [r for r in reqs if r.get("kind") == "main"]
    if not main:
        return None, None
    first = main[0]["n"]
    for n, body in evo._iter_bodies(rd):
        if n == first:
            s = json.dumps(body, sort_keys=True, ensure_ascii=False)
            s = s.replace(meta.get("nonce", "@@"), "NONCE").replace(meta.get("session_header", "@@"), "SESSION")
            g = f"{meta['group']}-{meta['label']}"
            s = s.replace(g, "GROUP-RUN")
            s = re.sub(r"evo-(fold|native|baseline)-run\d+-\d+", "CT", s)
            return hashlib.sha256(s.encode()).hexdigest()[:16], s
    return None, None


def structure_counts(rd, reqs):
    main = {r["n"] for r in reqs if r.get("kind") == "main"}
    first = min(main) if main else None
    c = [0, 0, 0, 0]; nb = 0
    for n, body in evo._iter_bodies(rd):
        if n not in main or n == first:
            continue
        nb += 1
        msgs = body.get("messages") or []
        c[0] += any(m.get("role") == "assistant" for m in msgs)
        c[1] += any(m.get("role") == "tool" for m in msgs)
        c[2] += any(m.get("role") == "assistant" and m.get("tool_calls") for m in msgs)
        c[3] += any(m.get("role") == "assistant" and m.get("reasoning_content") for m in msgs)
    return c, nb


def main():
    out = sys.argv[1]
    rows, pool, firsts = [], {}, {}
    for rd in sys.argv[2:]:
        meta, reqs, turns = load(rd)
        g = meta["group"]
        score = {}
        sp = os.path.join(rd, "score", "score.json")
        if os.path.exists(sp):
            score = json.load(open(sp))
        h, s = norm_first(rd, meta, reqs)
        firsts[(g, meta["label"], rd)] = (h, s)
        c, nb = structure_counts(rd, reqs)
        bykind = {}
        for r in reqs:
            bykind.setdefault(r.get("kind"), []).append(r)
        for k, rs in bykind.items():
            pool.setdefault((g, k), []).extend(rs)
        allc = kstats(reqs)
        ms_turn = [round(t.get("ms", 0) / 1000) for t in turns]
        rows.append({
            "group": g, "label": meta["label"], "rd": os.path.basename(rd.rstrip("/")),
            "turns": f"{sum(1 for t in turns if t.get('rc') == 0)}/{len(turns)}/{meta.get('turns_planned')}",
            "rc": [t.get("rc") for t in turns], "turn_s": ms_turn, "turn_total_min": round(sum(ms_turn) / 60, 1),
            "files": [t.get("cum_files") for t in turns], "stop": meta.get("stop"),
            "f2p": score.get("f2p") or score.get("F2P"), "score": {k: v for k, v in score.items() if k in ("pass_rate", "f2p_pass", "f2p_total", "p2p_pass", "p2p_total")},
            "struct": c, "bodies": nb, "first": h,
            "kinds": {str(k): kstats(rs) for k, rs in bykind.items()}, "all": allc,
        })
    L = ["## Per run", "",
         "| group | run | turns ok/started/planned | turn rc | turn s | turn total min | cum files | stop | first main req (normalised sha) | main bodies w/ hist. assistant / tool / tool_calls / reasoning_content | cost USD (all kinds) | non-200 | F2P | P2P |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        c = r["struct"]
        L.append(f"| {r['group']} | {r['label']} | {r['turns']} | {r['rc']} | {r['turn_s']} | {r['turn_total_min']} | {r['files']} | {r['stop']} | `{r['first']}` | {c[0]} / {c[1]} / {c[2]} / {c[3]} (of {r['bodies']}) | {r['all']['cost']:.4f} | {r['all']['status']} | {r['score'].get('f2p_pass')}/{r['score'].get('f2p_total')} | {r['score'].get('p2p_pass')}/{r['score'].get('p2p_total')} |")
    L += ["", "## Per run and request kind", "",
          "| group | run | kind | n | with usage | w/o usage | reasoning med / p90 / max | reasoning sum | req ms med / p90 | output tok | cost USD | 429 | other HTTP err |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        for k, v in sorted(r["kinds"].items()):
            L.append(f"| {r['group']} | {r['label']} | {k} | {v['n']} | {v['usage']} | {v['no_usage']} | {v['r_med']} / {v['r_p90']} / {v['r_max']} | {v['r_sum']} | {v['ms_med']} / {v['ms_p90']} | {v['out']} | {v['cost']:.4f} | {v['n429']} | {v['http_err']} |")
    L += ["", "## Pooled per group and kind", "",
          "| group | kind | n | with usage | w/o usage | reasoning med / p90 / max | reasoning sum | req ms med / p90 | output tok | cost USD | 429 | other HTTP err |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for (g, k), rs in sorted(pool.items(), key=lambda x: (x[0][0], str(x[0][1]))):
        v = kstats(rs)
        L.append(f"| {g} | {k} | {v['n']} | {v['usage']} | {v['no_usage']} | {v['r_med']} / {v['r_p90']} / {v['r_max']} | {v['r_sum']} | {v['ms_med']} / {v['ms_p90']} | {v['out']} | {v['cost']:.4f} | {v['n429']} | {v['http_err']} |")
    hs = {}
    for (g, l, rd), (h, s) in firsts.items():
        hs.setdefault(h, []).append(f"{g}/{l}")
    L += ["", "## First main request after normalisation (nonce, session header, group-run path, container name)", ""]
    for h, who in hs.items():
        L.append(f"- `{h}`: {', '.join(who)}")
    open(out, "w").write("\n".join(L) + "\n")
    json.dump(rows, open(out + ".json", "w"), indent=1, default=str)
    # keep normalised first bodies for diffing
    for (g, l, rd), (h, s) in firsts.items():
        if s:
            open(os.path.join(os.path.dirname(out), f"first-{os.path.basename(rd.rstrip('/'))}.json"), "w").write(s)
    print("\n".join(L))


if __name__ == "__main__":
    main()
