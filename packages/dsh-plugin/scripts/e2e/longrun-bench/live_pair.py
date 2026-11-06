#!/usr/bin/env python3
"""Bounded observational live pair. Not a hard billing or sole-egress guarantee.

Secrets are supplied only by the Actions run. No credential is printed or saved.
This runner intentionally does not use unshare or the mock isolation prototype.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import time

from driver import make_plan, json_answer, save
from dsh_adapter import load_session, parse_turn, executed_tools, tool_protocol_errors, native_compactions, plugin_runtime_evidence

HERE = Path(__file__).resolve().parent


def rows(path):
    out=[]
    if Path(path).exists():
        for line in Path(path).read_text(errors='replace').splitlines():
            try: out.append(json.loads(line))
            except ValueError: pass
    return out


def observed_usage(requests):
    totals={'requests':len(requests),'successful':0,'missing_usage':0,'prompt_tokens':0,
            'cache_hit_tokens':0,'completion_tokens':0,'estimate_usd':0.0,
            'opencode_list_cost':0.0,'opencode_list_cost_records':0}
    kinds={}
    for r in requests:
        kind=r.get('kind','unknown'); kinds[kind]=kinds.get(kind,0)+1
        if r.get('status')==200: totals['successful']+=1
        u=r.get('usage') or {}
        p,o=u.get('prompt_tokens'),u.get('completion_tokens')
        if type(p) is not int or type(o) is not int:
            totals['missing_usage']+=1; continue
        h=u.get('prompt_cache_hit_tokens', (u.get('prompt_tokens_details') or {}).get('cached_tokens',0)) or 0
        totals['prompt_tokens']+=p; totals['cache_hit_tokens']+=h; totals['completion_tokens']+=o
        totals['estimate_usd']+=(h*.006+(p-h)*.30+o*1.20)/1e6
        cost=(u.get('opencode') or {}).get('list_cost')
        if type(cost) in (int,float):
            totals['opencode_list_cost']+=cost; totals['opencode_list_cost_records']+=1
    totals.update(kinds=kinds,estimate_basis='DeepSeek direct peak USD/M: hit .006, miss .30, output 1.20; not verified OpenCode Go bill',
                  all_calls_captured=False,hard_dollar_guarantee=False)
    return totals


def judge_turn(want, answer, expected, calls, completed):
    try: quality=json_answer(answer)==expected
    except (ValueError,TypeError): quality=False
    errors=tool_protocol_errors(calls)
    reads=[c.get('path') for c in calls if c.get('name')=='read']
    if reads!=['corpus/'+f for f in want.get('files',[])]: errors.append('wrong read paths/order or checkpoint source reread')
    if any(c.get('name') not in ('read','ctx_search','ctx_expand') for c in calls): errors.append('unexpected tool or scratch writing')
    return {'quality_pass':quality,'protocol_pass':bool(completed and not errors),'protocol_errors':errors}


def run(args):
    out=args.out.resolve(); out.mkdir(parents=True,exist_ok=False)
    root=Path(os.environ['E2E_ROOT']); repo=args.repo.resolve()
    plan=make_plan(out/'task',pairs=1)
    # Exact task/corpus hashes are identical across arms; only nonce/state differ.
    work=out/'work'; work.mkdir(); shutil.copytree(out/'task/corpus',work/'corpus')
    answers=json.loads((out/'task/verifier/answers.json').read_text())
    env=os.environ.copy()
    env.update(BENCH_NONCE=secrets.token_hex(8),OPENCODE_SESSION='longrun-'+args.arm+'-'+secrets.token_hex(8),
               BENCH_ABLATE='',MAGIC_CONTEXT_DEBUG_HISTORIAN='1',MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS='60000',
               LONGRUN_MAX_REQUESTS='300',LONGRUN_ESTIMATE_STOP_USD='4',LONGRUN_SECONDS='2400')
    started=time.monotonic(); wall_start=int(time.time()*1000)
    proxylog=(out/'proxy.log').open('w')
    proxy=subprocess.Popen(['node',str(HERE/'live_proxy.mjs'),'18731',str(out)],env=env,stdout=proxylog,stderr=subprocess.STDOUT,start_new_session=True)
    sid=None; turns=[]; events=[]; stop='all-turns'; db_snapshots=[]
    def command(argv, limit, logpath):
        proc=subprocess.Popen(argv,cwd=work,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
        try: log,_=proc.communicate(timeout=limit)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid,signal.SIGKILL); log,_=proc.communicate(timeout=10)
        logpath.write_text(log)
        return proc.returncode,log
    try:
        for _ in range(100):
            if proxy.poll() is not None: raise RuntimeError('recording proxy exited')
            if 'bench proxy on' in (out/'proxy.log').read_text(): break
            time.sleep(.1)
        else: raise RuntimeError('proxy readiness timeout')
        for want in plan['turns']:
            if time.monotonic()-started>=2400: stop='wall-time-limit'; break
            if (out/'proxy-stopped.json').exists(): stop='proxy-limit'; break
            before=max((e.get('seq',-1) for e in events),default=-1)
            argv=['node',os.environ['DSH_BIN'],'--profile','test' if args.arm=='plugin' else 'base',
                  '--patch',str(HERE.parent/'cache-bench/bench-model.yml')]
            if args.arm=='plugin': argv+=['--patch',str(HERE.parent/'cache-bench/bench-plugin.yml')]
            argv += [want['prompt'],'--json']
            if sid: argv+=['--session-id',sid]
            t0=int(time.time()*1000)
            rc,log=command(argv,min(300,max(1,2400-(time.monotonic()-started))),out/f'turn-{want["turn"]:02d}.log')
            parsed=parse_turn(log,expected_session=sid,exit_code=rc)
            if parsed['session_id']: sid=parsed['session_id']
            ev_error=None
            if sid:
                try: events,_=load_session(os.environ['DSH_HOME'],sid)
                except Exception as e: ev_error=str(e)
            calls=[c for c in executed_tools(events) if type(c.get('seq')) is int and c['seq']>before]
            result={**parsed,'turn':want['turn'],'kind':want['kind'],'t0':t0,'t1':int(time.time()*1000),
                    'fresh_process':True,'tool_calls':calls,'session_read_error':ev_error}
            result.update(judge_turn(want,parsed['answer'],answers[str(want['turn'])],calls,parsed['cli_completed'] and not ev_error))
            native=native_compactions(events)
            result['native_completed']=sum(c['completed'] for c in native)
            if args.arm=='plugin' and sid:
                db=Path(os.environ['XDG_DATA_HOME'])/'cortexkit/magic-context/context.db'
                if db.exists():
                    dr=subprocess.run(['bun',str(HERE.parent/'ci-r17.ts'),'session',str(db),sid,'65','bench/deepseek-v4.1-flash'],env=env,capture_output=True,text=True,timeout=30)
                    (out/f'db-{want["turn"]:02d}.json').write_text(dr.stdout)
                    try:
                        snap=json.loads(dr.stdout); db_snapshots.append(snap)
                        result['mc_compartments']=len(snap.get('compartments') or [])
                        result['mc_history_versions']=snap.get('compartmentHistoryVersions')
                        result['mc_meta']=snap.get('meta')
                    except ValueError: result['db_error']='snapshot not JSON'
            turns.append(result); save(out/'turns.json',turns)
            print(json.dumps({'arm':args.arm,'turn':want['turn'],'kind':want['kind'],'quality':result['quality_pass'],
                'protocol':result['protocol_pass'],'native_completed':result['native_completed'],
                'mc_compartments':result.get('mc_compartments'),'observed':observed_usage(rows(out/'requests.jsonl'))}),flush=True)
            if not parsed['cli_completed'] or ev_error: stop='failed-turn-no-retry'; break
    except Exception as e:
        stop='runner-error: '+str(e)
    finally:
        if proxy.poll() is None:
            os.killpg(proxy.pid,signal.SIGTERM)
        try: proxy.wait(timeout=10)
        except subprocess.TimeoutExpired: os.killpg(proxy.pid,signal.SIGKILL); proxy.wait(timeout=5)
        proxylog.close()
        (out/'session.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in events))
        req=rows(out/'requests.jsonl')
        runtime=plugin_runtime_evidence(events,sid)
        checkpoints=[t for t in turns if t['kind']=='checkpoint']
        report={'origin':'real-dsh-real-model-observational','arm':args.arm,'source_head':os.environ.get('GITHUB_SHA'),
                'dsh_version':'0.2.1-rc.5','model':'deepseek-v4.1-flash','session_id':sid,'stop':stop,
                'start_ms':wall_start,'end_ms':int(time.time()*1000),'elapsed_seconds':round(time.monotonic()-started,2),
                'planned_turns':len(plan['turns']),'completed_turns':sum(t['cli_completed'] for t in turns),'turns':turns,
                'file_hashes':plan['file_hashes'],'quality_passes':sum(t['quality_pass'] for t in turns),
                'protocol_passes':sum(t['protocol_pass'] for t in turns),
                'all_task_checks_pass':len(turns)==len(plan['turns']) and all(t['quality_pass'] and t['protocol_pass'] for t in turns),
                'checkpoints':checkpoints,'native_compactions':native_compactions(events),'plugin_runtime':runtime,
                'observed_usage':observed_usage(req),'limits':{'proxy_forwarded_requests':300,'wall_seconds':2400,'turn_seconds':300,
                'driver_retries':0,'proxy_request_timeout_seconds':120,'observed_estimate_stop_usd':4},
                'limitations':['One run per arm, parallel independent jobs; no statistical significance.',
                'Provider SDK/background retries may exist; proxy request/time limits bound only observed route.',
                'No sole-egress isolation or guaranteed total dollar cap; costs are estimates, not bills.',
                'Compaction completion, persisted MC compartments, served-context drops and checkpoint quality are distinct observations.',
                'Synthetic release-inventory memory task, not an end-to-end software engineering outcome.']}
        save(out/'report.json',report)
        summary=[f'# {args.arm}: real long-run observational test',f'Commit: {report["source_head"]}',
                 f'Stop: {stop}; completed {report["completed_turns"]}/{report["planned_turns"]} turns',
                 f'Exact answers: {report["quality_passes"]}; protocol: {report["protocol_passes"]}',
                 f'Checkpoint exact answers: {sum(t["quality_pass"] for t in checkpoints)}/{len(checkpoints)}',
                 f'Observed usage: {json.dumps(report["observed_usage"])}','',*report['limitations']]
        (out/'summary.md').write_text('\n\n'.join(summary)+'\n')
    return 0 if stop=='all-turns' else 1


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--repo',type=Path,required=True); p.add_argument('--out',type=Path,required=True); p.add_argument('--arm',choices=['baseline','plugin'],required=True)
    raise SystemExit(run(p.parse_args()))
