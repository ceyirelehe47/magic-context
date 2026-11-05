#!/usr/bin/env python3
"""Round 26 P2-5: judge install-accept.sh's accept.jsonl (A0–A4) and, round 33 (P0), the
release-candidate checks: A5 npm install next to DSH (B2), A6 the bin through npm's
symlink (B4), A7 ctx_expand without Magic's injected text in the packed tarball (B5),
A8 the bin through the profile's pnpm shim; C5–C7 are the same probes on the OLD
tarball (controls: they show the probe can see the defect; WARN when it cannot).
Exit 1 on any FAIL."""
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
# Round 33: the tarball versions come from the tarballs (meta line), so the OLD
# release can be any tag (dsh.2 default, dsh.6 for the dsh.7 candidate).
OLDV, NEWV = V("meta", "oldVersion"), V("meta", "newVersion")
old_is = lambda s: OLDV != "" and V(s, "version") == OLDV
add("A1", I("a", "install") == 0 and I("a", "setup") == 0 and I("a", "doctor") == 0 and I("a", "rc") == 0
    and I("a", "magicLines") > 0 and V("a", "db") == "yes" and I("a", "tags") > 0 and old_is("a"),
    "install the OLD tgz (%s): setup + doctor ok, a real turn runs with Magic active and writes the DB" % OLDV, a)
add("A2", I("b", "install") == 0 and I("b", "setup") == 0 and I("b", "doctor") == 0 and I("b", "rc") == 0
    and I("b", "magicLines") > 0 and I("b", "tagsBefore") > 0 and I("b", "tags") > I("b", "tagsBefore")
    and V("b", "integrity") == "ok" and V("b", "version") == NEWV != OLDV,
    "upgrade to the HEAD tgz in place: same session continues, earlier rows kept, integrity ok", b)
add("A3", I("c", "setup") == 0 and I("c", "rc") == 0 and I("c", "magicLines") == 0 and I("c", "tags") == I("c", "tagsBefore")
    and I("c", "doctor") == 0 and I("c", "doctorDisabled") > 0,
    "disable (setup --disable-preset root): the turn runs with no Magic line and no Magic write; doctor exits 0 and says 'disabled in every preset' (round 27 C2)", c)
ok_d = I("d", "install") == 0 and I("d", "setup") == 0 and I("d", "doctor") == 0 and I("d", "rc") == 0 \
    and I("d", "magicLines") > 0 and I("d", "tags") >= I("d", "tagsBefore") > 0 and V("d", "integrity") == "ok" and old_is("d")
fenced = I("d", "install") == 0 and I("d", "schemaLines") > 0 and not ok_d
add("A4", True if ok_d else ("warn" if fenced else False),
    "roll back to the OLD tgz: data readable (turn runs, rows kept) — or an explicit schema refusal (WARN, documented)", d)
# A0 (round 29; lane from 28b): which steps needed DSH's exact-version
# exemption (allow-<step>.log) or had doctor's DSH version line as their only
# FAIL (doctorPin=1). install-accept.sh does either ONLY for a tarball that
# does not declare the running DSH. PASS = no step needed either; WARN = only
# the OLD release's steps (a, d: dsh.2 predates the declaration); FAIL = a
# HEAD step (b, c) needed one, i.e. HEAD does not declare this DSH.
pin = [k for k in "abcd" if I(k, "doctorPin") == 1]
exempt = sorted(p.name for p in out.glob("allow-*.log"))
head_needed = [k for k in pin if k in "bc"] + [e for e in exempt if e in ("allow-b.log", "allow-c.log")]
add("A0", False if head_needed else (True if not pin and not exempt else "warn"),
    "HEAD declares this DSH: no exemption and a clean doctor on the HEAD steps (b, c); "
    "an exemption / version-line-only doctor FAIL is allowed only for the OLD tarball's steps (a, d) when it does not declare this DSH",
    {"pinOnlySteps": pin, "exemptions": exempt, "headNeeded": head_needed})
# ---- round 33 (P0): release-candidate probes
npm = {}
p = out / "npm-bin.jsonl"
if p.exists():
    for line in p.read_text(errors="replace").splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        npm[o.get("label")] = o
def npm_ok(o):
    return str(o.get("npmRc")) == "0" and str(o.get("eresolve")) == "0"
def bin_ok(o):
    w = o.get("want", "")
    return (str(o.get("link")) == "1" and w != "" and all(o.get(k) == w for k in ("vexec", "vnode", "vdirect", "vnpx"))
            and int(o.get("doctorLines") or 0) > 0)
h, o_ = npm.get("head", {}), npm.get("old", {})
add("A5", bool(h) and npm_ok(h),
    "npm install of the HEAD tgz next to the npm-installed DSH, no --force / --legacy-peer-deps (B2)",
    {k: h.get(k) for k in ("npmRc", "eresolve", "dsh", "cordis")})
add("A6", bool(h) and npm_ok(h) and bin_ok(h),
    "HEAD bin through npm's node_modules/.bin symlink: exec / node <link> / node dist/cli.js / npx all print the version, doctor prints (B4)",
    {k: h.get(k) for k in ("link", "linkTarget", "want", "vexec", "vnode", "vdirect", "vnpx", "doctorLines")})
add("A7", V("b", "expandStatus") == "completed" and I("b", "expandUser") > 0 and I("b", "expandInjected") == 0,
    "HEAD tgz ctx_expand over the session's first ordinals shows the user's text and none of Magic's injected <session-history>/<project-memory>/<ctx-search-hint> (B5)",
    {k: b.get(k) for k in ("expandStatus", "expandLen", "expandUser", "expandInjected")} | {"memWrite(a)": a.get("memStatus")})
add("A8", V("b", "binPnpm") == NEWV,
    "HEAD bin through the profile's pnpm .bin shim prints the version", {"binPnpm": V("b", "binPnpm"), "want": NEWV})
# controls on the OLD tarball (every tag up to dsh.6 predates the B2/B4/B5 fixes)
if o_:
    add("C5", True if not npm_ok(o_) else "warn",
        "control: npm install of the OLD tgz (expected ERESOLVE on 0.2.2-alpha.3 / rc.1; on rc.5 the old cordis peer matches, so WARN there just means no B2 on rc.5)",
        {k: o_.get(k) for k in ("npmRc", "eresolve", "cordis")})
    if npm_ok(o_):
        add("C6", True if o_.get("vnode", "") in ("", "<missing>") and o_.get("vdirect") == o_.get("want") else "warn",
            "control: OLD bin through the symlink prints nothing under node while dist/cli.js prints the version (B4 visible to the probe)",
            {k: o_.get(k) for k in ("link", "vexec", "vnode", "vdirect", "vnpx", "doctorLines")})
add("C7", True if V("d", "expandStatus") == "completed" and I("d", "expandInjected") > 0 else "warn",
    "control: OLD tgz ctx_expand in the same session shows the injected text (B5 visible to the probe)",
    {k: d.get(k) for k in ("expandStatus", "expandLen", "expandUser", "expandInjected")})
print("tarballs: OLD %s, HEAD %s; DSH installed %s" % (OLDV or "?", NEWV or "?", V("meta", "dshInstalled") or "?"))
print("| id | result | check | detail |\n|---|---|---|---|")
for r in rows:
    print("| %s | %s | %s | %s |" % r)
sys.exit(1 if any(r[1] == "FAIL" for r in rows) else 0)
