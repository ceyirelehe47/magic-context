#!/usr/bin/env python3
"""Round 36 line I (CompactionBench-style evo bench): build one task from SWE-EVO.

    prepare.py <instance_id> <task-dir> [--max-items N] [--rows rows.json]

Fetches the SWE-EVO instance (Fsoft-AIC/SWE-EVO, HF datasets-server API, or a
local rows.json) and writes into <task-dir>:
  instance.json   metadata (repo, base_commit, image, test cmd, versions); no patches
  requests.json   the user turns, in order (CompactionBench appendix A):
                  changelog split into bullet-level requirements (multi-line kept),
                  items with a PR number in ascending PR order, the rest after in
                  original order; turn 1 also states the repository and release goal
  items.json      the parsed items (text, pr, original index)
  tests.json      FAIL_TO_PASS / PASS_TO_PASS test ids (scoring only)
  test.patch      the release's test changes (scoring only, never shown to the agent)
  gold.patch      the release's source changes (harness validation only)
Links (PR / docs URLs) are removed from the request text: the agent has web
tools and the PR diff would be the answer (a stricter rule than the paper,
which only strips git history; see i-evo-bench.md).
"""
import json, os, re, sys, time, urllib.request

DS = "Fsoft-AIC/SWE-EVO"


def fetch_rows(path=None):
    if path:
        return json.load(open(path))["rows"]
    rows, off = [], 0
    while True:
        url = f"https://datasets-server.huggingface.co/rows?dataset={DS}&config=default&split=test&offset={off}&length=100"
        for attempt in range(4):  # run 42255053410 baseline 2: IncompleteRead from datasets-server
            try:
                d = json.load(urllib.request.urlopen(url, timeout=120))
                break
            except Exception as e:
                if attempt == 3:
                    raise
                print(f"rows fetch retry {attempt + 1}: {type(e).__name__}", file=sys.stderr)
                time.sleep(10 * (attempt + 1))
        rows += d["rows"]
        off += 100
        if off >= d.get("num_rows_total", 0):
            return rows


def split_items(ps):
    items, cur = [], None
    for line in ps.splitlines():
        if re.match(r"^\s{0,1}[-*] ", line):
            if cur:
                items.append(cur)
            cur = re.sub(r"^\s{0,1}[-*] ", "", line).rstrip()
        elif cur is not None and line.strip():
            cur += "\n" + line.rstrip()
        elif cur is None and line.strip():
            cur = line.strip()  # preamble without a bullet: its own item
    if cur:
        items.append(cur)
    out = []
    for i, t in enumerate(items):
        m = re.findall(r"/pull/(\d+)", t)
        clean = re.sub(r"\s*Docs:\s*\[[^\]]*\]\(https?://[^)\s]*\)", "", t)  # "Docs: [:page_with_curl:](url)"
        clean = re.sub(r"\s*\(https?://[^)\s]*\)", "", clean)  # "(https://github.com/.../pull/N)"
        clean = re.sub(r"\s*https?://\S+", "", clean)  # bare links
        clean = re.sub(r"\.\s*\.(\s|$)", r".\1", clean)  # "...). Docs" leftovers: ". ." -> "."
        clean = re.sub(r"[ \t]+([.,;])", r"\1", clean).strip()
        out.append({"idx": i, "pr": int(m[0]) if m else None, "text": clean, "raw": t})
    with_pr = sorted([x for x in out if x["pr"] is not None], key=lambda x: x["pr"])
    return with_pr + [x for x in out if x["pr"] is None]


def main():
    a = sys.argv[1:]
    iid, td = a[0], a[1]
    maxn = int(a[a.index("--max-items") + 1]) if "--max-items" in a else 0
    rows = fetch_rows(a[a.index("--rows") + 1] if "--rows" in a else None)
    r = next(x["row"] for x in rows if x["row"]["instance_id"] == iid)
    os.makedirs(td, exist_ok=True)
    items = split_items(r["problem_statement"])
    total = len(items)
    if maxn and maxn < total:
        items = items[:maxn]
    repo, sv, ev = r["repo"], r["start_version"], r["end_version"]
    reqs = []
    for k, it in enumerate(items):
        if k == 0:
            head = (f"This working directory is a checkout of {repo} at release {sv}. Over this session I will ask you, "
                    f"one requirement at a time, to implement the changes that make up release {ev} (taken from its changelog). "
                    "Implement each requirement in the source code and keep the earlier ones working. "
                    "The project's test environment is reachable through the command `evo-pytest` (pytest with the project's "
                    "dependencies, run in this directory, e.g. `evo-pytest path/to/test_file.py -x -q`); the full suite is slow, "
                    "so run only the tests relevant to the change. You may add or update tests. "
                    f"There is no version-control history here, and network access to code hosts and package indexes is blocked; "
                    f"do not try to obtain the {ev} code from elsewhere.\n\n"
                    f"Requirement 1 of {len(items)}:\n{it['text']}")
        else:
            head = f"Next requirement for release {ev} ({k + 1} of {len(items)}):\n{it['text']}"
        reqs.append(head)
    meta = {k: r[k] for k in ("repo", "instance_id", "base_commit", "image", "test_cmds", "log_parser",
                               "start_version", "end_version", "end_version_commit", "environment_setup_commit")}
    meta.update({"items_total": total, "items_used": len(items), "truncated": total != len(items)})
    json.dump(meta, open(os.path.join(td, "instance.json"), "w"), indent=1)
    json.dump(reqs, open(os.path.join(td, "requests.json"), "w"), indent=1, ensure_ascii=False)
    json.dump(items, open(os.path.join(td, "items.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"FAIL_TO_PASS": r["FAIL_TO_PASS"], "PASS_TO_PASS": r["PASS_TO_PASS"]}, open(os.path.join(td, "tests.json"), "w"), indent=1)
    open(os.path.join(td, "test.patch"), "w").write(r["test_patch"])
    open(os.path.join(td, "gold.patch"), "w").write(r["patch"])
    print(f"{iid}: {len(items)}/{total} items, {len(r['FAIL_TO_PASS'])} F2P + {len(r['PASS_TO_PASS'])} P2P tests, image {r['image']}")


if __name__ == "__main__":
    main()
