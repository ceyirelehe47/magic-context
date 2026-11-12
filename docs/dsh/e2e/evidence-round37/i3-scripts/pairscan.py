#!/usr/bin/env python3
"""Round 37 seg 13 — paired evo comparison (MC vs DSH native) of two run dirs.

    pairscan.py <label=run-dir> <label=run-dir> [--i4 label=i4scan.json ...] [--json out.json]

Per run: stop / turns / timeouts, requests and HTTP statuses (429), cost by kind (summary.md.json,
analyze.py prices), cache hit (all / main / publication requests / other main), compactions
(compaction/start events), historian publications (i4scan publications_at), Magic write-backs of
DSH-pruned tool results (restores), max_completion_tokens of main requests (evo-maxtokens.json),
whether a native compaction came before the first MC publication, <unsummarized_tail> in bodies,
access probe leaks, F2P / P2P (bench) and prefix-match rescore (r38 rescore.py logic)."""
import json, os, re, subprocess, sys, statistics

sys.path.insert(0, "/workspace/work/mc-i/packages/dsh-plugin/scripts/e2e/evo-bench")
from score import parse_rA  # noqa: E402

PRUNE_MARKER = "[... tool result middle pruned ...]"
TESTS = "/workspace/work/r37b/art/evo22/dsh-e2e-evobench-native-run1-42805322951/tests.json"
BEYOND10 = {"conans/test/integration/command_v2/test_cache_integrity.py::test_cache_integrity",
            "conans/test/integration/command_v2/test_cache_clean.py::test_cache_clean"}


def rescore(rd):
    p = os.path.join(rd, "score", "test.log")
    if not os.path.exists(p): return None
    st = parse_rA(open(p, errors="replace").read())
    T = json.load(open(TESTS))
    def ok(t):
        if st.get(t) in ("PASSED", "XFAIL"): return True
        if t in st: return False
        c = [k for k in st if k.startswith(t)]
        return len(c) == 1 and st[c[0]] in ("PASSED", "XFAIL")
    F10 = [t for t in T["FAIL_TO_PASS"] if t not in BEYOND10]; P10 = [t for t in T["PASS_TO_PASS"] if t not in BEYOND10]
    return {"f2p": f"{sum(map(ok, T['FAIL_TO_PASS']))}/8", "p2p": f"{sum(map(ok, T['PASS_TO_PASS']))}/317",
            "f2p10": f"{sum(map(ok, F10))}/{len(F10)}", "p2p10": f"{sum(map(ok, P10))}/{len(P10)}"}


def body_grep(rd, needle):
    tz = os.path.join(rd, "bodies.tar.zst")
    if not os.path.exists(tz): return None
    dst = os.path.join("/workspace/work/r39/_bodies", os.path.basename(os.path.abspath(rd)))
    if not os.path.isdir(dst):
        os.makedirs(dst); subprocess.run(["tar", "-I", "zstd", "-xf", tz, "-C", dst], check=False)
    out = subprocess.run(["grep", "-rlF", needle, dst], capture_output=True, text=True).stdout.split()
    return sorted(os.path.basename(x)[:-5] for x in out if x.endswith(".json"))


def scan(label, rd, i4=None):
    S = json.load(open(os.path.join(rd, "summary.md.json")))["runs"][0]
    reqs = [json.loads(l) for l in open(os.path.join(rd, "requests.jsonl")) if l.strip()]
    kinds = json.load(open(os.path.join(rd, "evo-kinds.json"))) if os.path.exists(os.path.join(rd, "evo-kinds.json")) else {}
    for r in reqs: r["k"] = kinds.get(str(r["n"]), r.get("kind"))
    status = {}
    for r in reqs: status[r.get("status")] = status.get(r.get("status"), 0) + 1
    def hitf(rs):
        p = sum((r.get("usage") or {}).get("prompt_tokens") or 0 for r in rs)
        c = sum(((r.get("usage") or {}).get("prompt_tokens_details") or {}).get("cached_tokens") or 0 for r in rs)
        return (c / p if p else None), p - c
    main = [r for r in reqs if r["k"] == "main"]
    pubs = set(i4["publications_at"]) if i4 else set()
    pubreq = [r for r in main if r["n"] in pubs]; other = [r for r in main if r["n"] not in pubs]
    # max_completion_tokens of main requests from the bodies' maxtokens map
    mt = json.load(open(os.path.join(rd, "evo-maxtokens.json"))) if os.path.exists(os.path.join(rd, "evo-maxtokens.json")) else {}
    mvals = []
    for k, v in mt.items():
        kind, _, val = k.partition(":")
        if kind == "main": mvals += [int(val)] * v
    buckets = {"<4096": 0, "4096–16383": 0, "16384–32767": 0, "32768": 0}
    for v in mvals:
        buckets["<4096" if v < 4096 else "4096–16383" if v < 16384 else "16384–32767" if v < 32768 else "32768"] += 1
    # session: compactions, restores, publications order
    comp, restores, prunes = [], 0, 0
    texts = {}
    for l in open(os.path.join(rd, "session.jsonl")):
        try: e = json.loads(l)
        except Exception: continue
        t = e.get("type")
        if t == "compaction/start": comp.append((e.get("seq"), e.get("time")))
        if t == "tool/result":
            msg = (e.get("data") or {}).get("message") or {}
            txt = "".join(b.get("text", "") for b in msg.get("content") or [] if isinstance(b, dict))
            texts[e.get("seq")] = txt
            src = e.get("sourceEventSeqs") or []
            if PRUNE_MARKER in txt and not any(PRUNE_MARKER in texts.get(s, "") for s in src): prunes += 1
            if src and PRUNE_MARKER not in txt and any(PRUNE_MARKER in texts.get(s, "") for s in src) and len(txt) > max(len(texts.get(s, "")) for s in src):
                restores += 1
    # compactions vs first publication, by main request time
    first_pub_t = min((r["t0"] for r in main if r["n"] in pubs), default=None)
    comp_before_pub = [c for c in comp if first_pub_t is None or (c[1] or 0) < first_pub_t] if pubs else None
    turns = [json.loads(l) for l in open(os.path.join(rd, "turns.jsonl")) if l.strip()]
    timeouts = [t["turn"] for t in turns if t.get("rc") in (124, 137)]
    tails = body_grep(rd, "<unsummarized_tail")
    probe = json.load(open(os.path.join(rd, "probe", "probe.json"))) if os.path.exists(os.path.join(rd, "probe", "probe.json")) else {}
    bk = S.get("by_kind")
    h_all = S.get("hit_rate"); h_main, miss_main = hitf(main); h_pub, miss_pub = hitf(pubreq); h_other, _ = hitf(other)
    return {
        "label": label, "dir": rd, "stop": S.get("stop_class"), "turns": f"{S.get('turns_completed')}/{S.get('turns_run')}/{S.get('turns_planned')}",
        "timeouts": timeouts, "turn_time_total_s": S.get("turn_time_s"), "wall_s": S.get("wall_s"),
        "requests": S.get("requests"), "status": status, "http_429": status.get(429, 0), "main_without_usage": S.get("main_without_usage"),
        "cost": S.get("cost"), "cost_by_kind": {k: round(v["cost"], 4) for k, v in bk.items()}, "n_by_kind": {k: v["n"] for k, v in bk.items()},
        "hit_all": h_all, "hit_main": h_main, "pub_n": len(pubreq), "hit_pub": h_pub, "pub_miss_share": (miss_pub / miss_main if miss_main else None), "hit_main_nonpub": h_other,
        "compactions": len(comp), "publications": len(pubs), "historian_req": bk.get("historian", {}).get("n", 0),
        "native_before_first_pub": (len(comp_before_pub) if comp_before_pub is not None else None),
        "dsh_prunes": prunes, "magic_restores": restores,
        "mct_min": min(mvals) if mvals else None, "mct_median": statistics.median(mvals) if mvals else None, "mct_buckets": buckets, "mct_n": len(mvals),
        "unsummarized_tail_bodies": (len(tails) if tails is not None else None), "unsummarized_tail_at": (tails or [])[:10],
        "probe_leaked": probe.get("leaked"), "probe_requests": probe.get("requests"), "net_attempts": S.get("net_attempts"), "history_probes": S.get("history_probes"),
        "f2p": S.get("f2p"), "p2p": S.get("p2p"), "rescore": rescore(rd), "peak_prompt": S.get("peak_prompt"),
    }


def main():
    args = sys.argv[1:]; runs, i4s, out = [], {}, None
    while args:
        a = args.pop(0)
        if a == "--i4": l, p = args.pop(0).split("=", 1); i4s[l] = json.load(open(p))
        elif a == "--json": out = args.pop(0)
        else: runs.append(a.split("=", 1))
    rows = [scan(l, d, i4s.get(l)) for l, d in runs]
    keys = [k for k in rows[0] if k not in ("dir",)]
    print("| metric | " + " | ".join(r["label"] for r in rows) + " |")
    print("|---|" + "---|" * len(rows))
    for k in keys:
        if k == "label": continue
        def fmt(v):
            if isinstance(v, float): return f"{v:.4f}" if v < 100 else f"{v:.1f}"
            return str(v)
        print(f"| {k} | " + " | ".join(fmt(r[k]) for r in rows) + " |")
    if out: json.dump(rows, open(out, "w"), indent=1, default=str)


main()
