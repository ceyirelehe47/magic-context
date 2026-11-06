#!/usr/bin/env python3
"""Round 36 line I: score one source patch with the release's repository tests.

    score.py <task-dir> <source.patch> <out-dir> [--label L]

CompactionBench appendix A: the final cumulative SOURCE patch is scored with the
repository tests; agent changes to test files are excluded. Steps, in a fresh
container of the instance image (never the one the agent used):
  1. git checkout -f <base_commit> (clean tree)
  2. apply <source.patch> with test files filtered out (filter_patch below)
  3. apply the release's test.patch (SWE-EVO test_patch)
  4. run pytest (instance test_cmds, -rA) on the test FILES that hold the
     FAIL_TO_PASS + PASS_TO_PASS ids, parse the -rA summary
Score = passed listed tests / all listed tests (each test weighs 1, i.e. the
paper's test-weighted accuracy for one task); F2P and P2P are reported apart.
Writes <out-dir>/score.json, test.log, applied.patch, excluded-files.txt.
"""
import json, os, re, subprocess as sp, sys, time

TEST_PATH = re.compile(r"(^|/)(tests?|testing)/|(^|/)test_[^/]*\.py$|_tests?\.py$|(^|/)conftest\.py$")


def sh(cmd, **kw):
    return sp.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def filter_patch(text):
    keep, drop, cur, cur_path = [], [], [], None
    def flush():
        if cur_path is None:
            return
        (drop if TEST_PATH.search(cur_path) else keep).append((cur_path, "".join(cur)))
    for line in text.splitlines(keepends=True):
        m = re.match(r"^diff --git a/(\S+) b/(\S+)", line)
        if m:
            flush()
            cur, cur_path = [line], m.group(2)
        elif cur_path is not None:
            cur.append(line)
    flush()
    return "".join(p for _, p in keep), [f for f, _ in keep], [f for f, _ in drop]


STATUSES = ("PASSED", "FAILED", "ERROR", "SKIPPED", "XFAIL", "XPASS")


def parse_rA(log):
    res = {}
    for line in log.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
        for st in STATUSES:
            if line.startswith(st + " "):
                tid = line[len(st) + 1:]
                if st in ("FAILED", "ERROR") and " - " in tid:
                    tid = tid.split(" - ")[0]
                res[tid.strip()] = st
    return res


def main():
    a = sys.argv[1:]
    td, patch, out = a[0], a[1], a[2]
    label = a[a.index("--label") + 1] if "--label" in a else os.path.basename(out.rstrip("/"))
    os.makedirs(out, exist_ok=True)
    meta = json.load(open(os.path.join(td, "instance.json")))
    tests = json.load(open(os.path.join(td, "tests.json")))
    src = open(patch, errors="replace").read() if os.path.exists(patch) else ""
    kept, kept_files, dropped = filter_patch(src)
    open(os.path.join(out, "applied.patch"), "w").write(kept)
    open(os.path.join(out, "excluded-files.txt"), "w").write("\n".join(dropped) + ("\n" if dropped else ""))
    name = f"evo-score-{os.getpid()}-{int(time.time())}"
    img = meta["image"]
    t0 = time.time()
    r = sh(["docker", "run", "-d", "--name", name, img, "sleep", "infinity"])
    if r.returncode:
        print(r.stderr); sys.exit(2)
    try:
        def ex(c, timeout=600):
            return sh(["docker", "exec", "-w", "/testbed", name, "bash", "-c", c], timeout=timeout)
        info = {"label": label, "image": img, "source_files": kept_files, "excluded_test_files": dropped}
        r = ex(f"git checkout -q -f {meta['base_commit']} && git clean -q -fd -e '*.egg-info' && git rev-parse HEAD")
        info["base_checkout"] = (r.stdout.strip(), r.returncode, r.stderr[-300:])
        sh(["docker", "cp", os.path.join(out, "applied.patch"), f"{name}:/tmp/src.patch"])
        sh(["docker", "cp", os.path.join(td, "test.patch"), f"{name}:/tmp/test.patch"])
        apply = "true"
        if kept.strip():
            r = ex("git apply --whitespace=nowarn /tmp/src.patch || git apply --whitespace=nowarn --reject /tmp/src.patch")
            info["src_apply_rc"] = r.returncode
            info["src_apply_err"] = r.stderr[-1500:]
        r = ex("git apply --whitespace=nowarn /tmp/test.patch")
        info["test_apply_rc"], info["test_apply_err"] = r.returncode, r.stderr[-1500:]
        ids = tests["FAIL_TO_PASS"] + tests["PASS_TO_PASS"]
        files = sorted({t.split("::")[0] for t in ids})
        cmd = meta.get("test_cmds") or "pytest -rA"
        act = "source /opt/miniconda3/bin/activate testbed 2>/dev/null || true"
        r = ex(f"{act}; export PYTHONDONTWRITEBYTECODE=1; {cmd} -p no:cacheprovider {' '.join(files)}", timeout=int(os.environ.get("EVO_SCORE_TIMEOUT", "3000")))
        log = r.stdout + "\n" + r.stderr
        open(os.path.join(out, "test.log"), "w").write(log)
        st = parse_rA(log)
        def ok(t):
            return st.get(t) in ("PASSED", "XFAIL")
        f2p = sum(ok(t) for t in tests["FAIL_TO_PASS"]); p2p = sum(ok(t) for t in tests["PASS_TO_PASS"])
        n1, n2 = len(tests["FAIL_TO_PASS"]), len(tests["PASS_TO_PASS"])
        info.update({
            "pytest_rc": r.returncode, "parsed_results": len(st),
            "listed_tests": n1 + n2, "listed_found": sum(t in st for t in ids),
            "f2p_pass": f2p, "f2p_total": n1, "p2p_pass": p2p, "p2p_total": n2,
            "pass_rate": (f2p + p2p) / (n1 + n2) if n1 + n2 else None,
            "resolved": f2p == n1 and p2p == n2,
            "f2p_failed": [t for t in tests["FAIL_TO_PASS"] if not ok(t)],
            "p2p_failed": [t for t in tests["PASS_TO_PASS"] if not ok(t)],
            "seconds": round(time.time() - t0, 1),
        })
    finally:
        sh(["docker", "rm", "-f", name])
    json.dump(info, open(os.path.join(out, "score.json"), "w"), indent=1)
    print(f"[score {label}] pass {info.get('f2p_pass')}/{info.get('f2p_total')} F2P, {info.get('p2p_pass')}/{info.get('p2p_total')} P2P, rate {info.get('pass_rate')}, parsed {info.get('parsed_results')}, {info.get('seconds')}s")


if __name__ == "__main__":
    main()
