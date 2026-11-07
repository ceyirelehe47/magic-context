"""Round 37: tool-call pairing check on one OpenAI-style messages list (every tool answers a call of the
assistant that opened its run; no orphan, no duplicate, no unanswered call before the next assistant / user)."""
import json,sys
def check(m):
    v=[]; open_ids=set(); answered=set()
    for i,x in enumerate(m):
        r=x['role']
        if r=='assistant':
            if open_ids-answered: v.append((i,'unanswered before assistant',sorted(open_ids-answered)[:3]))
            open_ids={c['id'] for c in (x.get('tool_calls') or [])}; answered=set()
        elif r=='tool':
            t=x.get('tool_call_id')
            if t not in open_ids: v.append((i,'orphan tool',t))
            elif t in answered: v.append((i,'dup answer',t))
            answered.add(t)
        elif r=='user':
            if open_ids-answered: v.append((i,'unanswered before user',sorted(open_ids-answered)[:3]))
            open_ids=set(); answered=set()
    return v
if __name__=='__main__':
    for f in sys.argv[1:]:
        b=json.load(open(f)); m=b['messages']
        asst=[x for x in m if x['role']=='assistant']
        print(f, 'violations', check(m)[:5], 'assistants', len(asst), 'with reasoning_content', sum(1 for x in asst if x.get('reasoning_content')), 'with tool_calls', sum(1 for x in asst if x.get('tool_calls')))
