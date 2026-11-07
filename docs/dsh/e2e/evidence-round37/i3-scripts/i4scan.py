#!/usr/bin/env python3
"""Round 37 phase 2 — I4 scan of one evo run's recorded request bodies.

    i4scan.py <run-dir> <out.md>

Per main / subagent / historian body: active knowledge baselines (user messages that START with
<session-history> = m0, <session-history-since> = m1), the compartment ranges each m0 covers
("## a-b · title" headings), body bytes, message count, assistant-with-tool_calls / tool / reasoning
counts and the tool-call pairing check (i3-scripts/pairing.py). Publications are the main requests
whose newest m0 covers a range the previous main request did not have. Also lists the historian
requests and the backstop "native pressure check" lines of the turn logs.
"""
import json, os, re, sys, tarfile, io
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
PAIR = str(__import__("pathlib").Path(__file__).with_name("pairing.py"))
spec = importlib.util.spec_from_file_location("pairing", PAIR); pairing = importlib.util.module_from_spec(spec); spec.loader.exec_module(pairing)

rd, outp = sys.argv[1], sys.argv[2]
reqs = {r["n"]: r for r in (json.loads(l) for l in open(os.path.join(rd, "requests.jsonl")) if l.strip())}
kinds = json.load(open(os.path.join(rd, "evo-kinds.json"))) if os.path.exists(os.path.join(rd, "evo-kinds.json")) else {}
def kind(n): return kinds.get(str(n), reqs.get(n, {}).get("kind"))

bodies = {}
import subprocess
raw = subprocess.run(["tar", "-I", "zstd", "-xOf", os.path.join(rd, "bodies.tar.zst"), "--wildcards", "*.json"], capture_output=True).stdout
# tar -O concatenates; read the member list to split by size instead
names = subprocess.run(["tar", "-I", "zstd", "-tvf", os.path.join(rd, "bodies.tar.zst")], capture_output=True, text=True).stdout.splitlines()
off = 0
for line in names:
    parts = line.split()
    if not parts or parts[0].startswith("d"): continue
    size = int(parts[2]); name = parts[-1]
    data = raw[off:off + size]; off += size
    m = re.search(r"(\d+)\.json$", name)
    if m: bodies[int(m.group(1))] = data

def text(c):
    if isinstance(c, str): return c
    if isinstance(c, list): return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""

rows = []
for n in sorted(bodies):
    k = kind(n)
    if k not in ("main", "subagent", "historian", "summarizer"): continue
    try: b = json.loads(bodies[n])
    except Exception: continue
    msgs = b.get("messages") or []
    m0, m1, ranges = [], [], []
    for i, m in enumerate(msgs):
        if m.get("role") != "user": continue
        t = text(m.get("content")).lstrip()
        if t.startswith("<session-history>"):
            rs = re.findall(r"^## (\d+)-(\d+) ·", t, re.M)
            m0.append(i); ranges.append([(int(a), int(z)) for a, z in rs])
        elif t.startswith("<session-history-since>"):
            m1.append(i)
    asst_tc = sum(1 for m in msgs if m.get("role") == "assistant" and m.get("tool_calls"))
    asst_tc_noreason = sum(1 for m in msgs if m.get("role") == "assistant" and m.get("tool_calls") and not m.get("reasoning_content"))
    tools = sum(1 for m in msgs if m.get("role") == "tool")
    viol = pairing.check(msgs) if k != "historian" else []
    r = reqs.get(n, {})
    u = r.get("usage") or {}
    rows.append({
        "n": n, "kind": k, "bytes": len(bodies[n]), "msgs": len(msgs), "m0": len(m0), "m1": len(m1),
        "m0_ranges": ranges, "asst_tc": asst_tc, "asst_tc_noreason": asst_tc_noreason, "tools": tools,
        "pair_viol": len(viol), "status": r.get("status"), "ms": r.get("ms"),
        "prompt": u.get("prompt_tokens"), "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens"),
        "reasoning": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"), "out": u.get("completion_tokens"),
        "finish": r.get("finish"), "t0": r.get("t0"),
    })

def cover(rs):
    s = set()
    for a, z in rs: s.update(range(a, z + 1))
    return s

main = [r for r in rows if r["kind"] == "main"]
pubs = []
prev_cov = set()
for r in main:
    cov = cover(r["m0_ranges"][-1]) if r["m0_ranges"] else set()
    if cov - prev_cov:
        pubs.append(r["n"])
    r["cover_max"] = max(cov) if cov else 0
    r["cover_gaps"] = sorted(set(range(1, max(cov) + 1)) - cov) if cov else []
    prev_cov = cov if cov else prev_cov

hist = [r for r in rows if r["kind"] == "historian"]
hist_status = [(n, rr.get("status"), rr.get("finish")) for n, rr in sorted(reqs.items()) if kind(n) == "historian"]
press = []
for f in sorted(os.listdir(rd)):
    if f.startswith("turn-") and f.endswith(".log"):
        for i, l in enumerate(open(os.path.join(rd, f), errors="replace"), 1):
            if "native pressure check" in l or "backstop" in l.lower():
                press.append((f, i, l.strip()[:400]))

# reasoning replay: distinct historical assistant tool-call messages (by name+arguments) without
# reasoning_content, and how many of those had reasoning in the recorded response (= reasoning lost)
import glob
resp_reason = {}
for f in glob.glob(os.path.join(rd, "resp", "*.json")):
    try: rr = json.load(open(f))
    except Exception: continue
    for tc in rr.get("tool_calls") or []:
        resp_reason[(tc.get("name"), tc.get("arguments"))] = bool(rr.get("reasoning"))
distinct, noreason = set(), set()
for n, data in bodies.items():
    if kind(n) not in ("main", "subagent"): continue
    try: b = json.loads(data)
    except Exception: continue
    for m in b.get("messages") or []:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            key = tuple(((c.get("function") or {}).get("name"), (c.get("function") or {}).get("arguments")) for c in m["tool_calls"])
            distinct.add(key)
            if not m.get("reasoning_content"): noreason.add(key)
lost = [k for k in noreason if any(resp_reason.get(x) for x in k)]

summary = {
    "main_bodies": len(main), "max_active_m0": max((r["m0"] for r in main), default=0),
    "bodies_with_m0_gt1": [r["n"] for r in main if r["m0"] > 1],
    "bodies_with_m1_gt1": [r["n"] for r in main if r["m1"] > 1],
    "publications_at": pubs, "historian_requests": hist_status,
    "pair_violations": sum(r["pair_viol"] for r in rows), "distinct_hist_assistant_toolcall_msgs": len(distinct), "without_reasoning_content": len(noreason), "reasoning_lost_vs_response": len(lost),
    "coverage_gaps_in_latest": {r["n"]: r["cover_gaps"] for r in main if r.get("cover_gaps")},
    "pressure_lines": len(press),
}
with open(outp, "w") as o:
    o.write(f"# I4 scan — {rd}\n\n```json\n{json.dumps(summary, indent=1)}\n```\n\n")
    o.write("## Publications (main request where the newest m0 gains a range): before / at / after\n\n")
    o.write("| n | kind | active m0 | m1 | newest m0 ranges | body bytes | msgs | prompt tok | cached | reasoning | ms |\n|---|---|---|---|---|---|---|---|---|---|---|\n")
    idx = {r["n"]: i for i, r in enumerate(main)}
    for p in pubs:
        i = idx[p]
        for r in main[max(0, i - 1): i + 2]:
            rg = r["m0_ranges"][-1] if r["m0_ranges"] else []
            o.write(f"| {r['n']} | {r['kind']} | {r['m0']} | {r['m1']} | {rg} | {r['bytes']} | {r['msgs']} | {r['prompt']} | {r['cached']} | {r['reasoning']} | {r['ms']} |\n")
        o.write("| | | | | | | | | | | |\n")
    o.write("\n## Backstop / pressure lines (turn logs)\n\n")
    for f, i, l in press: o.write(f"- `{f}:{i}` {l}\n")
    o.write("\n## Every request (main / subagent / historian)\n\n| n | kind | status | finish | active m0 | m1 | cover max | gaps | bytes | msgs | asst w/ tool_calls | … without reasoning | tool msgs | pairing violations | prompt | cached | reasoning | out | ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
    for r in rows:
        o.write(f"| {r['n']} | {r['kind']} | {r['status']} | {r['finish']} | {r['m0']} | {r['m1']} | {r.get('cover_max','')} | {r.get('cover_gaps','')} | {r['bytes']} | {r['msgs']} | {r['asst_tc']} | {r['asst_tc_noreason']} | {r['tools']} | {r['pair_viol']} | {r['prompt']} | {r['cached']} | {r['reasoning']} | {r['out']} | {r['ms']} |\n")
json.dump(summary, open(outp + ".json", "w"), indent=1)
print(json.dumps(summary, indent=1))
