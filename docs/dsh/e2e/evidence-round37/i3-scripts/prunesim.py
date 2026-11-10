import json,math,sys
M="\n\n[... tool result middle pruned ...]\n\n"
rows=json.load(open(sys.argv[1])); bd=sys.argv[2]
def text(c):
    if isinstance(c,str): return c
    return "".join(b.get("text","") for b in (c or []) if isinstance(b,dict) and b.get("type")=="text")
withmarker=0; out=[]
for r in rows:
    b=json.load(open(f"{bd}/{r['n']}.json"))
    big=0; save=0; mk=0
    for m in b["messages"]:
        if m.get("role")!="tool": continue
        t=text(m.get("content"))
        if M in t: mk+=1
        L=len(t)
        if L>8192 and M not in t:
            big+=1; save+=math.ceil(L/3.5)-math.ceil((4096+len(M)+1024)/3.5)
    if mk: withmarker+=1
    r.update(big=big,save=save,mk=mk); out.append(r)
print("bodies with marker:",withmarker,"of",len(out))
cl=[r for r in out if r['mct']<32768]
for r in sorted(cl,key=lambda r:r['mct'])[:8]:
    implied=200000-4096-r['mct']; newest=implied-r['save']
    print(r['n'],'mct',r['mct'],'prompt',r['prompt'],'big',r['big'],'mk',r['mk'],'save~',r['save'],'new mct~',min(32768,max(1,200000-4096-newest)))
import statistics
print('clamped: median save',statistics.median([r['save'] for r in cl]),'would stay clamped',sum(1 for r in cl if 200000-4096-(200000-4096-r['mct']-r['save'])<32768))
json.dump(out,open(sys.argv[3],'w'))
