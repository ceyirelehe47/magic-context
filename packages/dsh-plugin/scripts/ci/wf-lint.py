#!/usr/bin/env python3
"""Round 33 (P1-B) — false-positive audit of the fork's own DSH workflows.

    wf-lint.py lint [workflow-dir]          static rules over .github/workflows/dsh-*.yml (exit 1 on FAIL)
    wf-lint.py simulate <wf.yml> <job> <step-name-substring> --fail <cmd> [--fail <cmd> ...]
                                            run ONE step's `run:` block the way the runner does
                                            (same shell line), with <cmd> replaced on PATH by a stub
                                            that exits 1; prints the step's exit code
    wf-lint.py selftest                     the rules on built-in fixtures (exit 1 if a rule is wrong)

Rules (each a way a job can end green although the thing it tests failed):

  PIPE    a top-level pipeline (`a | tee …`) in a step whose shell has no pipefail.
          GitHub's default for a `run:` step WITHOUT `shell:` is `bash -e {0}` (no pipefail;
          job logs print "shell: /usr/bin/bash -e {0}"), so `script | tee summary` exits with
          tee's 0. OK when the step / job / workflow sets `shell: bash` (= `-eo pipefail`), the
          block runs `set -o pipefail` (or `set -…o pipefail`) before the line, or the line (or
          the next one) reads PIPESTATUS.
  COE     `continue-on-error: true` on a step that no later step of the job gates on
          (`steps.<id>.outcome|conclusion` referenced in a later step that can `exit`).
  REPORT  a job that installs or overlays a DSH must put the DSH version actually installed
          ("DSH version (installed): <v>", read from the installed package.json), the node version (`node -v` / `node --version`) and GITHUB_SHA into
          $GITHUB_STEP_SUMMARY.

Workflows the round may not change (dsh-soak.yml: round 33 constraint) are reported as WARN.
Upstream workflows (not dsh-*.yml) are out of scope.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

FROZEN = {"dsh-soak.yml": "not changed in round 33 (soak frozen by the task constraints)"}


# ---------------------------------------------------------------- shell text helpers
def _strip_heredocs(text):
    out, lines, i = [], text.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r"<<(-?)\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
        if m:
            tag, dash = m.group(2), m.group(1) == "-"
            i += 1
            while i < len(lines) and (lines[i].lstrip("\t") if dash else lines[i]).strip() != tag:
                i += 1
        i += 1
    return "\n".join(out)


def _strip_quotes_and_subst(s):
    """Remove quoted strings, $( … ) / `…` substitutions and comments (top-level view only)."""
    res, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            i += 2
            continue
        if c == "'":
            j = s.find("'", i + 1)
            i = n if j < 0 else j + 1
            res.append("''")
            continue
        if c == '"':
            j, depth = i + 1, 0
            while j < n:
                if s[j] == "\\":
                    j += 2
                    continue
                if s.startswith("$(", j):
                    depth += 1
                elif s[j] == ")" and depth:
                    depth -= 1
                elif s[j] == '"' and not depth:
                    break
                j += 1
            i = j + 1
            res.append('""')
            continue
        if s.startswith("$(", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if s[j] == "(":
                    depth += 1
                elif s[j] == ")":
                    depth -= 1
                j += 1
            i = j
            res.append("$X")
            continue
        if c == "`":
            j = s.find("`", i + 1)
            i = n if j < 0 else j + 1
            res.append("$X")
            continue
        if c == "#" and (i == 0 or s[i - 1] in " \t;"):
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        res.append(c)
        i += 1
    return "".join(res)


def logical_lines(block):
    text = _strip_heredocs(block.replace("\\\n", " "))
    return text.split("\n")


def has_pipe(line):
    t = _strip_quotes_and_subst(line)
    t = t.replace("||", "  ")
    return "|" in t


SETS_PIPEFAIL = re.compile(r"\bset\s+(-[a-zA-Z]*o\s+pipefail|-o\s+pipefail|-[a-zA-Z]*\s+-o\s+pipefail)\b")


def pipe_findings(block, shell):
    """[(lineno, line)] of top-level pipelines whose failure the step would not see."""
    if shell and re.match(r"^bash(\s|$)", shell) and ("pipefail" in shell or shell.strip() == "bash"):
        return []
    found, pipefail = [], False
    lines = logical_lines(block)
    for k, line in enumerate(lines):
        if SETS_PIPEFAIL.search(line):
            pipefail = True
        if pipefail or not has_pipe(line):
            continue
        nxt = next((l for l in lines[k + 1:] if l.strip()), "")
        if "PIPESTATUS" in line or "PIPESTATUS" in nxt:
            continue
        found.append((k + 1, line.strip()))
    return found


def effective_shell(wf, job, step):
    return (step.get("shell") or ((job.get("defaults") or {}).get("run") or {}).get("shell")
            or ((wf.get("defaults") or {}).get("run") or {}).get("shell"))


def runner_shell_cmd(shell, path):
    """The command line the runner uses for a `run:` step (Linux)."""
    if not shell:
        return ["/bin/bash", "-e", path]
    if shell.strip() == "bash":
        return ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", path]
    if shell.strip() == "sh":
        return ["/bin/sh", "-e", path]
    return [x.replace("{0}", path) for x in shell.split()]


# ---------------------------------------------------------------- rules
def lint_workflow(path):
    wf = yaml.safe_load(Path(path).read_text())
    rows = []
    name = Path(path).name
    for jid, job in (wf.get("jobs") or {}).items():
        steps = job.get("steps") or []
        for si, step in enumerate(steps):
            label = step.get("name") or step.get("id") or step.get("uses") or f"step {si + 1}"
            block = step.get("run")
            if isinstance(block, str):
                for ln, line in pipe_findings(block, effective_shell(wf, job, step)):
                    rows.append((name, jid, label, "PIPE", f"line {ln}: {line[:140]}"))
            if step.get("continue-on-error") is True:
                sid = step.get("id")
                later = "\n".join(str(s.get("run", "")) + str(s.get("if", "")) for s in steps[si + 1:])
                gated = sid and re.search(rf"steps\.{re.escape(sid)}\.(outcome|conclusion)", later) and "exit" in later
                if not gated:
                    rows.append((name, jid, label, "COE", f"continue-on-error without a later gate on steps.{sid}"))
        text = json.dumps(job)
        installs = re.search(r"@deepseek-ai/dsh@|bootstrap\.sh|overlay-dsh-|install-accept\.sh", text)
        if installs:
            missing = [w for w, rx in (("DSH version (installed)", r"DSH version \(installed\)"), ("node -v", r"node (-v|--version)"),
                                       ("GITHUB_SHA", r"GITHUB_SHA")) if not re.search(rx, text)]
            if missing or "GITHUB_STEP_SUMMARY" not in text:
                rows.append((name, jid, "(job)", "REPORT", "summary lacks " + ", ".join(missing or ["GITHUB_STEP_SUMMARY"])))
    return rows


def cmd_lint(wdir):
    rows = []
    for p in sorted(Path(wdir).glob("dsh-*.yml")):
        rows += lint_workflow(p)
    print("| workflow | job | step | rule | finding | verdict |\n|---|---|---|---|---|---|")
    bad = 0
    for r in rows:
        verdict = "WARN (" + FROZEN[r[0]] + ")" if r[0] in FROZEN else "FAIL"
        bad += verdict == "FAIL"
        print("| %s | %s | %s | %s | %s | %s |" % (*r, verdict))
    print(f"\n{len(rows)} finding(s), {bad} FAIL")
    return 1 if bad else 0


def cmd_simulate(wf_path, job_id, step_sub, fails):
    wf = yaml.safe_load(Path(wf_path).read_text())
    job = wf["jobs"][job_id]
    step = next(s for s in job["steps"] if step_sub in str(s.get("name", "")))
    block = re.sub(r"\$\{\{[^}]*\}\}", "X", step["run"])
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp, "stub-bin")
        stub.mkdir()
        for c in fails:
            p = stub / c
            p.write_text(f"#!/bin/sh\necho \"stub {c}: failing on purpose ($*)\" >&2\nexit 1\n")
            p.chmod(0o755)
        script = Path(tmp, "step.sh")
        script.write_text(block)
        env = dict(os.environ, PATH=f"{stub}:{os.environ['PATH']}", RUNNER_TEMP=tmp,
                   GITHUB_STEP_SUMMARY=str(Path(tmp, "summary.md")), GITHUB_ENV=str(Path(tmp, "env")),
                   GITHUB_OUTPUT=str(Path(tmp, "out")), GITHUB_SHA="0" * 40)
        cmd = runner_shell_cmd(effective_shell(wf, job, step), str(script))
        p = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, timeout=60)
        print(f"step '{step.get('name')}' ({wf_path}:{job_id}) shell={' '.join(cmd[:-1])} stubs={fails}")
        print("stderr:", p.stderr.strip()[-400:])
        print(f"step exit code: {p.returncode}")
        return p.returncode


FIXTURE_BAD = """
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: overlay
        run: bash overlay.sh 1 2 | tee -a "$GITHUB_STEP_SUMMARY"
      - name: tests
        id: t
        continue-on-error: true
        run: bun test
      - name: install dsh
        run: npm install @deepseek-ai/dsh@1
"""
FIXTURE_GOOD = """
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: overlay
        run: |
          set -o pipefail
          bash overlay.sh 1 2 | tee -a "$GITHUB_STEP_SUMMARY"
      - name: pipestatus
        run: bun test 2>&1 | tee x.log; exit ${PIPESTATUS[0]}
      - name: shell bash
        shell: bash
        run: bash overlay.sh | tee y
      - name: quoted and subst only
        run: |
          echo "a | b" ; x=$(echo 1 | wc -l); [ a ] || true
          python3 - <<'PY'
          print("x | y")
          PY
      - name: tests
        id: t
        continue-on-error: true
        run: bun test
      - name: install dsh
        run: npm install @deepseek-ai/dsh@1
      - name: Summary
        run: |
          echo "DSH version (installed): $(cat v) node $(node -v) ${GITHUB_SHA}" >> "$GITHUB_STEP_SUMMARY"
          [ "${{ steps.t.outcome }}" = success ] || exit 1
"""


def cmd_selftest():
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        bad, good = Path(tmp, "dsh-bad.yml"), Path(tmp, "dsh-good.yml")
        bad.write_text(FIXTURE_BAD)
        good.write_text(FIXTURE_GOOD)
        rb = sorted(r[3] for r in lint_workflow(bad))
        rg = lint_workflow(good)
        if rb != ["COE", "PIPE", "REPORT"]:
            print("selftest FAIL: bad fixture rules", rb)
            ok = False
        if rg:
            print("selftest FAIL: good fixture flagged", rg)
            ok = False
        # the PIPE rule is about real runner semantics: prove it on bash itself
        Path(tmp, "overlay.sh").write_text("exit 1\n")
        for shell, want in ((None, 0), ("bash", 1)):
            s = Path(tmp, "s.sh")
            s.write_text('bash overlay.sh | tee -a summary.md\n')
            rc = subprocess.run(runner_shell_cmd(shell, str(s)), cwd=tmp).returncode
            if rc != want:
                print(f"selftest FAIL: shell={shell!r} rc={rc} want {want}")
                ok = False
    print("selftest", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "lint":
        root = Path(__file__).resolve().parents[4]
        sys.exit(cmd_lint(a[1] if len(a) > 1 else root / ".github" / "workflows"))
    if a[0] == "selftest":
        sys.exit(cmd_selftest())
    if a[0] == "simulate":
        fails = [a[i + 1] for i, x in enumerate(a) if x == "--fail"]
        sys.exit(0 if cmd_simulate(a[1], a[2], a[3], fails) is not None else 1)
    print(__doc__)
    sys.exit(2)
