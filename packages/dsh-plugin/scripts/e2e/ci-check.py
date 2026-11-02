#!/usr/bin/env python3
"""Judge the output of ci-e2e.sh (dsh-ci.yml, job `e2e`).

    ci-check.py check  <ci-out-dir>   # writes <dir>/summary.md, exit 1 on any FAIL
    ci-check.py redact <ci-out-dir>   # scrub secrets / home paths in place (run before upload)

The model key is read from OPENCODE_API_KEY only to replace it; it is never
printed. Checks (ids are referenced from summary.md and DSH-MAINTENANCE.md):

  N*  worker self-test, default timeout   (round 13 A1/A2/A3/A5 on CI)
  T*  worker self-test, 1500 ms timeout   (A4 + re-verification of 502d74b94)
  M*  one session over three processes    (§N§ tag identity across restarts)
  P1  no dsh process left after the runs
"""
import json
import os
import re
import sys
from pathlib import Path

ALLOWED_CHILD_TOOLS = {"read", "grep", "glob", "fs_search"}
MASKED = ("bash", "write", "edit", "ctx_search", "ctx_reduce")
TAG_PREFIX = re.compile(r"^\s*§(\d+)§")


def events(path: Path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def selftest_report(path: Path):
    for ev in events(path):
        if ev.get("type") == "tool_result" and str(ev.get("result", "")).startswith("WORKER_SELFTEST "):
            try:
                return json.loads(ev["result"][len("WORKER_SELFTEST "):])
            except Exception:
                return None
    return None


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


class Checks:
    def __init__(self):
        self.rows = []

    def add(self, cid, ok, what, detail=""):
        self.rows.append((cid, "PASS" if ok is True else ("WARN" if ok == "warn" else "FAIL"), what, detail))

    @property
    def failed(self):
        return any(r[1] == "FAIL" for r in self.rows)


def child_rows(db, cid):
    if not db or cid not in db:
        return None
    return sum(db[cid]["counts"].values())


def check_child_log(c, prefix, path: Path, expect_abort: bool):
    evs = events(path)
    if not evs:
        c.add(f"{prefix}c", "warn", "child session log decoded", "child session file not found")
        return
    tools = set()
    leaked_guidance = False
    tagged_text = False
    turn_end = None
    sandbox = []
    for e in evs:
        t, d = e.get("type"), e.get("data", {})
        if t == "request/header":
            tools |= {x.get("name") for x in d.get("header", {}).get("tools", [])}
        elif t == "system/message":
            s = json.dumps(d.get("message"), ensure_ascii=False)
            leaked_guidance |= "## Magic Context" in s or "§" in s
        elif t == "assistant/message":
            for blk in d.get("message", {}).get("content", []):
                if blk.get("type") == "text" and "§" in blk.get("text", ""):
                    tagged_text = True
        elif t == "turn/end":
            turn_end = d.get("reason")
        elif t == "sandbox/mode":
            sandbox.append(d.get("mode"))
    if tools:
        c.add(f"{prefix}c1", tools <= ALLOWED_CHILD_TOOLS, "child request carries only read-only tools", sorted(tools))
    c.add(f"{prefix}c2", not leaked_guidance, "no Magic guidance / §N§ in child system prompt")
    c.add(f"{prefix}c3", not tagged_text, "child assistant text has no §N§")
    if expect_abort:
        c.add(f"{prefix}c4", isinstance(turn_end, dict) and turn_end.get("kind") == "aborted",
              "child turn/end aborted (disposed)", turn_end)
    c.add(f"{prefix}c5", True, "child sandbox/mode events (informational)", sandbox)


def check(out: Path) -> int:
    c = Checks()
    runs = {}
    for line in (out / "runs.tsv").read_text().splitlines() if (out / "runs.tsv").exists() else []:
        name, sid, tail = (line.split("\t") + ["", ""])[:3]
        runs[name] = (sid, tail)  # a retried run keeps its last attempt
    db_st = load_json(out / "db-selftest.json")
    children = {}
    if (out / "children.txt").exists():
        for line in (out / "children.txt").read_text().splitlines():
            n, cid = line.split("\t")
            children[n] = cid

    # --- N: normal self-test
    r = selftest_report(out / "selftest-normal.log")
    c.add("N0", r is not None, "selftest-normal: ctx_worker_selftest called", runs.get("selftest-normal", ("", ""))[1])
    if r is not None:
        c.add("N1", r.get("ok") is True, "worker ok:true", {"durationMs": r.get("durationMs"), "workerLog": r.get("workerLog")})
        vis = r.get("childVisibleTools") or []
        c.add("N2", bool(vis) and set(vis) <= ALLOWED_CHILD_TOOLS, "child visible tools ⊆ read/grep/glob", vis)
        res = r.get("toolResolution") or {}
        masked_ok = all(res.get(n, {}).get("child") is False for n in MASKED if n in res)
        ro_ok = all(res.get(n, {}).get("child") is True for n in ("read", "glob", "grep") if n in res)
        c.add("N3", bool(res) and masked_ok and ro_ok, "executor resolution: masked child:false, read-only child:true",
              {k: v.get("child") for k, v in res.items()})
        c.add("N4", "§" not in str(r.get("workerText") or ""), "workerText has no §N§")
        cid = r.get("childSessionId")
        n = child_rows(db_st, cid)
        c.add("N5", n == 0, "child has 0 Magic DB rows", n)
        check_child_log(c, "N", out / "child-selftest-normal.jsonl", expect_abort=False)

    # --- T: 1500 ms timeout (502d74b94)
    r = selftest_report(out / "selftest-timeout.log")
    c.add("T0", r is not None, "selftest-timeout: ctx_worker_selftest called", runs.get("selftest-timeout", ("", ""))[1])
    if r is not None:
        c.add("T1", r.get("ok") is False and r.get("workerText") is None, "worker ok:false after timeout",
              {"timeoutMs": r.get("timeoutMs")})
        wl = r.get("workerLog") or []
        c.add("T2", any("timed out after 1500ms" in m for m in wl),
              "502d74b94: workerLog names the reason (timed out after 1500ms; child disposed)", wl)
        n = child_rows(db_st, r.get("childSessionId"))
        c.add("T3", n in (0, None), "child has 0 Magic DB rows", n)
        check_child_log(c, "T", out / "child-selftest-timeout.jsonl", expect_abort=True)

    # --- M: one session, three processes
    finals = {}
    for k in (1, 2, 3):
        name = f"multi-{k}"
        tail = runs.get(name, ("", "missing"))[1]
        c.add(f"M0.{k}", tail.startswith("rc=0"), f"{name} exit", tail)
        for e in events(out / f"{name}.log"):
            if e.get("type") == "final":
                finals[k] = e.get("text", "")
    dumps = {}
    sid = (out / "multi.sid").read_text().strip() if (out / "multi.sid").exists() else ""
    for k in (1, 2, 3):
        d = load_json(out / f"db-multi-{k}.json")
        if d and sid in d:
            dumps[k] = d[sid]["tags"]
    for k, tags in dumps.items():
        nums = [t["tag_number"] for t in tags]
        mids = [t["message_id"] for t in tags]
        c.add(f"M1.{k}", len(nums) == len(set(nums)) and len(mids) == len(set(mids)),
              f"after turn {k}: tag numbers and message ids unique", {"tags": len(nums)})
        c.add(f"M2.{k}", sorted(nums) == list(range(1, len(nums) + 1)),
              f"after turn {k}: tag numbers contiguous 1..N", sorted(nums))
    ks = sorted(dumps)
    for a, b in zip(ks, ks[1:]):
        before = {t["message_id"]: t["tag_number"] for t in dumps[a]}
        after = {t["message_id"]: t["tag_number"] for t in dumps[b]}
        changed = {m: (n, after.get(m)) for m, n in before.items() if after.get(m) != n}
        c.add(f"M3.{a}-{b}", not changed, f"restart {a}->{b}: every earlier tag keeps its number", changed or len(before))
    c.add("M4", len(dumps) == 3, "tag dumps after all three turns", sorted(dumps))
    for k, text in finals.items():
        m = TAG_PREFIX.match(text)
        if not m:
            continue
        n = int(m.group(1))
        # The reply is tagged on the next pass (next turn), so after turn k its
        # number must still be free (else the model reused a number another
        # message owns: the round 7/8 duplicate-§N§ symptom). Model-side
        # behaviour, so a WARN, not a FAIL.
        taken = [t["message_id"] for t in dumps.get(k, []) if t["tag_number"] == n]
        c.add(f"M5.{k}", True if not taken else "warn",
              f"turn {k} reply prefix §{n}§ not already owned by another message", taken or "free")

    # --- P: process hygiene
    left = (out / "leftover-procs.txt").read_text().split() if (out / "leftover-procs.txt").exists() else []
    c.add("P1", not left, "no leftover dsh processes", len(left))

    lines = ["# DSH e2e (CI)", "", "| check | result | what | detail |", "|---|---|---|---|"]
    for cid, res, what, detail in c.rows:
        d = json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail
        d = d.replace("|", "\\|")
        if len(d) > 300:
            d = d[:300] + "…"
        lines.append(f"| {cid} | {res} | {what} | {d} |")
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 1 if c.failed else 0


REDACT = [
    (re.compile(r"(sk-)[A-Za-z0-9_-]{6,}"), r"\1<REDACTED>"),
    (re.compile(r"((?:api[_-]?key|token|authorization|bearer)[\"']?\s*[:=]?\s*[\"']?)[A-Za-z0-9._-]{16,}", re.I),
     r"\1<REDACTED>"),
]


def redact(out: Path) -> int:
    key = os.environ.get("OPENCODE_API_KEY", "")
    home = os.environ.get("HOME", "")
    hits = 0
    for p in out.rglob("*"):
        if not p.is_file():
            continue
        try:
            s = p.read_text(errors="replace")
        except Exception:
            continue
        t = s
        if len(key) >= 8:
            hits += t.count(key)
            t = t.replace(key, "<REDACTED:OPENCODE_API_KEY>")
        for rx, rep in REDACT:
            t = rx.sub(rep, t)
        if home:
            t = t.replace(home, "~")
        if t != s:
            p.write_text(t)
    print(f"redact: {sum(1 for _ in out.rglob('*'))} files scanned, literal key occurrences replaced: {hits}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("check", "redact"):
        print(__doc__)
        sys.exit(2)
    d = Path(sys.argv[2])
    sys.exit(check(d) if sys.argv[1] == "check" else redact(d))
