import sys, json, glob, os, re, statistics as st
sys.path.insert(0, "packages/dsh-plugin/scripts/e2e/cache-bench")
import analyze
for rid in sys.argv[1:]:
  for d in sorted(glob.glob(f"./art/{rid}/dsh-e2e-cachebench-*/run*")):
    r=analyze.run_stats(d); st_=r["steps"]
    last=json.load(open(f"{d}/bodies/{st_[-1]['req']}.json"))
    txt=json.dumps(last["messages"])
    if r["mode"]=="plugin":
        reads=re.findall(r"read the file [^;.\\]*?(p\d\d)\.txt", txt)
        reduce_=len(re.findall(r"ctx_reduce", " ".join(json.dumps(m) for m in last["messages"][1:])))
    else:
        reads=[re.search(r"p\d\d",tc["function"]["arguments"]).group(0) for m in last["messages"] for tc in (m.get("tool_calls") or []) if "p" in tc["function"]["arguments"]]
        reduce_=0
    uniq=len(set(reads))
    content=[ (s["completion_tokens"] or 0)-(s["reasoning_tokens"] or 0) for s in st_ if s["completion_tokens"] is not None]
    rs=[s["reasoning_tokens"] or 0 for s in st_ if s["completion_tokens"] is not None]
    print(f"{rid} {r['mode']:8} {r['label']} steps={len(st_):3} reads={len(reads):3} uniqfiles={uniq:2} rereads={len(reads)-uniq:2} steps/file={len(st_)/max(uniq,1):.2f} content/step={st.mean(content):.0f} rsn/step={st.mean(rs):.0f} zero-rsn-steps={sum(1 for x in rs if x==0)}/{len(rs)} lastprompt={st_[-1]['prompt_tokens']}")
