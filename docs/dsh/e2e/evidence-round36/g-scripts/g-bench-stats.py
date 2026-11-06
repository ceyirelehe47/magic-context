#!/usr/bin/env python3
"""Round 36 line G: per-run ctx_reduce calls, read calls / repeats, first nudge body and first
historian request from a cache-bench artifact dir (plugin group). Usage: g-bench-stats.py <dir>..."""
import collections, glob, json, os, sys

for base in sys.argv[1:]:
    for meta in sorted(glob.glob(base + "/**/run*/meta.json", recursive=True)):
        d = os.path.dirname(meta)
        m = json.load(open(meta))
        if m["mode"] != "plugin":
            continue
        reqs = [json.loads(l) for l in open(d + "/requests.jsonl")]
        first_h = next((r["n"] for r in reqs if r["kind"] == "historian"), None)
        nudge = None
        for r in reqs:
            s = open(f"{d}/bodies/{r['n']}.json").read()
            if nudge is None and ("spent tool outputs" in s or "Call ctx_reduce now" in s):
                nudge = r["n"]
        calls, paths = collections.Counter(), collections.Counter()
        for f in glob.glob(d + "/resp/*.json"):
            x = json.load(open(f))
            if x.get("kind") != "main":
                continue
            for tc in x.get("tool_calls") or []:
                calls[tc["name"]] += 1
                if tc["name"] == "read":
                    paths[json.loads(tc["arguments"]).get("file_path")] += 1
        print(base, os.path.basename(d), "native", m.get("native_roles"), "requests", len(reqs),
              "first historian", first_h, "first nudge body", nudge, "ctx_reduce", calls["ctx_reduce"],
              "reads", sum(paths.values()), "repeat", sum(v - 1 for v in paths.values() if v > 1))
