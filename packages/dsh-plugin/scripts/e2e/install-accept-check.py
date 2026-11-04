#!/usr/bin/env python3
"""Round 26 P2-5: judge install-accept.sh's accept.jsonl (A1–A4). Exit 1 on any FAIL."""
import json, sys
from pathlib import Path

out = Path(sys.argv[1])
steps = {}
for line in (out / "accept.jsonl").read_text(errors="replace").splitlines():
    try:
        o = json.loads(line)
    except Exception:
        continue
    steps[o.get("step")] = o
I = lambda s, k: int(str(steps.get(s, {}).get(k, "-1")).strip() or -1) if str(steps.get(s, {}).get(k, "-1")).strip().lstrip("-").isdigit() else -1
V = lambda s, k: str(steps.get(s, {}).get(k, ""))
rows = []
def add(cid, ok, what, detail):
    rows.append((cid, "PASS" if ok is True else ("WARN" if ok == "warn" else "FAIL"), what, json.dumps(detail, ensure_ascii=False)[:400]))

a, b, c, d = (steps.get(k, {}) for k in "abcd")
add("A1", I("a", "install") == 0 and I("a", "setup") == 0 and I("a", "doctor") == 0 and I("a", "rc") == 0
    and I("a", "magicLines") > 0 and V("a", "db") == "yes" and I("a", "tags") > 0 and "dsh.2" in V("a", "version"),
    "install dsh.2 tgz: setup + doctor ok, a real turn runs with Magic active and writes the DB", a)
add("A2", I("b", "install") == 0 and I("b", "setup") == 0 and I("b", "doctor") == 0 and I("b", "rc") == 0
    and I("b", "magicLines") > 0 and I("b", "tagsBefore") > 0 and I("b", "tags") > I("b", "tagsBefore")
    and V("b", "integrity") == "ok" and "dsh.2" not in V("b", "version") and V("b", "version") != "",
    "upgrade to the HEAD tgz in place: same session continues, earlier rows kept, integrity ok", b)
add("A3", I("c", "setup") == 0 and I("c", "rc") == 0 and I("c", "magicLines") == 0 and I("c", "tags") == I("c", "tagsBefore")
    and I("c", "doctor") == 0 and I("c", "doctorDisabled") > 0,
    "disable (setup --disable-preset root): the turn runs with no Magic line and no Magic write; doctor exits 0 and says 'disabled in every preset' (round 27 C2)", c)
ok_d = I("d", "install") == 0 and I("d", "setup") == 0 and I("d", "doctor") == 0 and I("d", "rc") == 0 \
    and I("d", "magicLines") > 0 and I("d", "tags") >= I("d", "tagsBefore") > 0 and V("d", "integrity") == "ok" and "dsh.2" in V("d", "version")
fenced = I("d", "install") == 0 and I("d", "schemaLines") > 0 and not ok_d
add("A4", True if ok_d else ("warn" if fenced else False),
    "roll back to dsh.2: data readable (turn runs, rows kept) — or an explicit schema refusal (WARN, documented)", d)
print("| id | result | check | detail |\n|---|---|---|---|")
for r in rows:
    print("| %s | %s | %s | %s |" % r)
sys.exit(1 if any(r[1] == "FAIL" for r in rows) else 0)
