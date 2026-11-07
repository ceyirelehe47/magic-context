"""Round 37: protocol check (pairing.check) over every main / subagent / historian body of evo runs.

    pairall.py <run-dir> [...]
"""
import os, sys, json, importlib.util
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pairing import check
_spec = importlib.util.spec_from_file_location("evo_analyze", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "..", "packages", "dsh-plugin", "scripts", "e2e", "evo-bench", "analyze.py"))
evo = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(evo)
for rd in sys.argv[1:]:
    k=json.load(open(rd+'/evo-kinds.json'))
    n=bad=0; ex=None; rcmiss=0
    for i,b in evo._iter_bodies(rd):
        if k.get(str(i)) not in ('main','subagent','historian'): continue
        n+=1; v=check(b.get('messages') or [])
        if v: bad+=1; ex=ex or (i,v[:2])
    print(rd[-45:], 'bodies',n,'with violations',bad, ex)
