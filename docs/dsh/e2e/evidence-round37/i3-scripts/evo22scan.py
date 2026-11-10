#!/usr/bin/env python3
"""Round 37 seg 10: historian fire / publication / cache timeline of one evo run.

    evo22scan.py <run-dir> <i4scan-json> [label]

Per turn: main requests, steps, fires=true, noop lines, historian requests, publications, compactions.
Each fires=true line (written after step k's step_end) is matched to main request k+1 of that turn and
classified: 'started' (a historian request starts within 20 s after that main request's t0 and before the next
fire), 'in-flight' (a historian request is running at that t0: lease busy, inferred — that log line goes to
ctx.logger, not stderr), 'noop' (a noop line follows the fire), 'other'.
Cache hit (cached/prompt) of the main request before / at / after each publication."""
import json, os, re, sys, statistics

rd, i4j = sys.argv[1], sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(rd.rstrip("/"))
reqs = [json.loads(l) for l in open(os.path.join(rd, "requests.jsonl")) if l.strip()]
kinds = json.load(open(os.path.join(rd, "evo-kinds.json")))
for r in reqs: r["k"] = kinds.get(str(r["n"]), r.get("kind"))
turns = [json.loads(l) for l in open(os.path.join(rd, "turns.jsonl")) if l.strip()]
i4 = json.load(open(i4j)); pubs = set(i4["publications_at"])
def turn_of(t):
    for tr in turns:
        if tr["t0"] <= t <= tr["t1"] + 1000: return tr["turn"]
    return None
for r in reqs: r["turn"] = turn_of(r["t0"])
def hit(r):
    u = r.get("usage") or {}; p = u.get("prompt_tokens") or 0
    c = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    return c / p if p else None
main = [r for r in reqs if r["k"] == "main"]; hist = [r for r in reqs if r["k"] == "historian"]
out = []
P = out.append
P(f"== {label}")
P("turn | main req (first-last) | steps | fires=true | noop lines | fire class started/in-flight/noop/other | historian req (n@s since turn start) | publications | compactions (checkpoint-only req)")
cp_only = []
ck = os.path.join(os.path.dirname(os.path.abspath(rd.rstrip('/'))), "ckscan-rows.json")
if os.path.exists(ck):
    cp_only = [x["n"] for x in json.load(open(ck)) if x["cp"] and not x["m0"]]
tot = {"started": 0, "in-flight": 0, "noop": 0, "other": 0}
for tr in turns:
    t = tr["turn"]; tm = [r for r in main if r["turn"] == t]; th = [r for r in hist if r["turn"] == t]
    log = open(os.path.join(rd, f"turn-{t:02d}.log"), errors="replace").read().splitlines()
    step, fires, cls = 0, [], []
    for i, line in enumerate(log):
        if '"phase":"step_end"' in line: step += 1
        if "fires=true" in line:
            nxt = log[i + 1] if i + 1 < len(log) else ""
            fires.append((step, "historian noop" in nxt))
    for k, (s, isnoop) in enumerate(fires):
        m = tm[s] if s < len(tm) else None
        if isnoop: c = "noop"
        elif m is None: c = "other"
        else:
            t0 = m["t0"]; nxt_t = tm[fires[k + 1][0]]["t0"] if k + 1 < len(fires) and fires[k + 1][0] < len(tm) else t0 + 20000
            if any(h["t0"] <= t0 <= h["t1"] for h in th): c = "in-flight"
            elif any(t0 - 2000 <= h["t0"] <= min(t0 + 20000, max(nxt_t, t0 + 2000)) for h in th): c = "started"
            else: c = "other"
        cls.append(c); tot[c] += 1
    cc = {x: cls.count(x) for x in ("started", "in-flight", "noop", "other")}
    hs = " ".join(f"{h['n']}@{(h['t0'] - tr['t0']) / 1000:.0f}" for h in th)
    pp = [n for n in sorted(pubs) if tm and tm[0]["n"] <= n <= tm[-1]["n"]]
    cc_ = [n for n in cp_only if tm and tm[0]["n"] <= n <= tm[-1]["n"]]
    noop = sum(1 for l in log if "historian noop" in l)
    P(f"{t} | {tm[0]['n'] if tm else '-'}-{tm[-1]['n'] if tm else '-'} ({len(tm)}) | {step} | {len(fires)} | {noop} | {cc['started']}/{cc['in-flight']}/{cc['noop']}/{cc['other']} | {hs or '-'} | {pp or '-'} | {cc_ or '-'}")
P(f"fire classes total: {tot}")
P("\npublication cache hits (main request before / publication request / next main):")
mi = {r["n"]: i for i, r in enumerate(main)}
rows = []
for n in sorted(pubs):
    if n not in mi: continue
    i = mi[n]; b = main[i - 1] if i else None; a = main[i + 1] if i + 1 < len(main) else None
    f = lambda r: f"{hit(r) * 100:.1f}" if r and hit(r) is not None else "-"
    rows.append((hit(b) if b else None, hit(main[i]), hit(a) if a else None))
    P(f"  pub {n}: {f(b)} -> {f(main[i])} -> {f(a)}  (prompt {(main[i].get('usage') or {}).get('prompt_tokens')})")
hp = [x[1] for x in rows if x[1] is not None]
others = [hit(r) for r in main if r["n"] not in pubs and r["n"] not in cp_only and hit(r) is not None]
P(f"  publication requests: n={len(hp)} mean hit {statistics.mean(hp) * 100:.1f} %, median {statistics.median(hp) * 100:.1f} %")
P(f"  other main requests (not publication / not first after compaction): n={len(others)} mean hit {statistics.mean(others) * 100:.1f} %")
allh = [hit(r) for r in main if hit(r) is not None]
P(f"  all main: n={len(allh)} mean hit {statistics.mean(allh) * 100:.1f} %; weighted (sum cached / sum prompt) "
  f"{sum((r.get('usage') or {}).get('prompt_tokens_details', {}).get('cached_tokens', 0) or 0 for r in main) / max(1, sum((r.get('usage') or {}).get('prompt_tokens', 0) or 0 for r in main)) * 100:.1f} %")
# miss tokens attributable to publication requests
def miss(r):
    u = r.get("usage") or {}; return (u.get("prompt_tokens") or 0) - ((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
mp = sum(miss(r) for r in main if r["n"] in pubs); mt = sum(miss(r) for r in main)
P(f"  main miss tokens: total {mt}, at publication requests {mp} ({mp / max(1, mt) * 100:.1f} %), at first-after-compaction {sum(miss(r) for r in main if r['n'] in cp_only)}")
P(f"\nturn times (s): {[round(tr['ms'] / 1000) for tr in turns]}; total {sum(tr['ms'] for tr in turns) / 1000:.0f}")
print("\n".join(out))
