#!/usr/bin/env python3
"""Recompute pi-ai 1.4.0 estimateContextTokens for each main request body and compare with
max_completion_tokens.  estscan.py <run-dir-with-requests.jsonl> <bodies-dir> [out.json]

Hypothesis H0 (static, dsh-llm-pi-ai 0.2.1-rc.5): every replayed assistant carries emptyPiUsage()
and timestamp 0 -> no usage anchor ever -> estimate = sum ceil(chars/3.5) over context.messages
(first system message is context.systemPrompt, not counted).  Variant B counts it too.
clamp: mct = min(maxTokens, max(1, 200000 - est - 4096)).
"""
import json, math, sys, os

def ceil35(n): return math.ceil(n / 3.5)

def text(c):
    if c is None: return ""
    if isinstance(c, str): return c
    return "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")

def msg_tokens(m):
    role = m.get("role")
    if role in ("system", "developer", "user", "tool"):
        t = text(m.get("content"))
        if role == "tool" and t == "": t = "(no output)"
        return ceil35(len(t))
    chars = len(text(m.get("content")))
    rc = m.get("reasoning_content") or m.get("reasoning") or ""
    chars += len(rc)
    for c in m.get("tool_calls") or []:
        f = c.get("function", {})
        try:
            args = json.dumps(json.loads(f.get("arguments") or "{}"), separators=(",", ":"), ensure_ascii=False)
        except Exception:
            args = f.get("arguments") or ""
        chars += len(f.get("name", "")) + len(args)
    return ceil35(chars)

run, bodies = sys.argv[1], sys.argv[2]
reqs = {}
for line in open(os.path.join(run, "requests.jsonl")):
    r = json.loads(line); reqs[r["n"]] = r
rows = []
for n, r in sorted(reqs.items()):
    if r.get("kind") != "main": continue
    p = os.path.join(bodies, f"{n}.json")
    if not os.path.exists(p): continue
    b = json.load(open(p))
    ms = b.get("messages", [])
    mct = b.get("max_completion_tokens") or b.get("max_tokens")
    first_sys = 1 if ms and ms[0].get("role") == "system" else 0
    estA = sum(msg_tokens(m) for m in ms[first_sys:])
    estB = sum(msg_tokens(m) for m in ms)
    predA = min(32768, max(1, 200000 - estA - 4096))
    predB = min(32768, max(1, 200000 - estB - 4096))
    pt = (r.get("usage") or {}).get("prompt_tokens")
    rows.append(dict(n=n, mct=mct, estA=estA, estB=estB, predA=predA, predB=predB, prompt=pt))
clamped = [x for x in rows if x["mct"] is not None and x["mct"] < 32768]
okA = sum(1 for x in clamped if x["predA"] == x["mct"]); okB = sum(1 for x in clamped if x["predB"] == x["mct"])
print(f"main bodies {len(rows)}; clamped (<32768) {len(clamped)}; exact match A(no sys) {okA}, B(with sys) {okB}")
unc = [x for x in rows if x["mct"] == 32768]
print(f"unclamped {len(unc)}: predA==32768 {sum(1 for x in unc if x['predA']==32768)}, predB==32768 {sum(1 for x in unc if x['predB']==32768)}")
for x in clamped[:5] + sorted(clamped, key=lambda x: x['mct'])[:5]:
    print(x, "est/prompt=%.3f" % (x["estA"] / x["prompt"]) if x["prompt"] else "")
ratios = [x["estA"] / x["prompt"] for x in rows if x["prompt"]]
ratios.sort()
if ratios:
    print("estA/prompt ratio min %.3f med %.3f max %.3f" % (ratios[0], ratios[len(ratios)//2], ratios[-1]))
if len(sys.argv) > 3:
    json.dump(rows, open(sys.argv[3], "w"))
