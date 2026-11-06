#!/usr/bin/env python3
"""Real DSH, local mock only, isolated network/PID namespaces. Not efficacy data.

Requires an existing dependency-installed source checkout and DSH installation.
Never installs, reads a real credential, accepts a vendor URL, or runs live.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time

from dsh_adapter import executed_tools, load_session, native_compactions, parse_turn, route_entries, smoke_evidence_errors
from mock_gateway import Gateway

HERE = Path(__file__).resolve().parent


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--dsh-install', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--arm', choices=['baseline', 'plugin'], default='baseline')
    p.add_argument('--mock-port', type=int, default=18979)
    a = p.parse_args()
    repo, install, root = a.repo.resolve(), a.dsh_install.resolve(), a.out.resolve()
    root.mkdir(parents=True, exist_ok=False)
    node = shutil.which('node')
    dsh = install/'node_modules/@deepseek-ai/dsh/lib/bin.js'
    if not node or not dsh.is_file():
        raise RuntimeError('existing Node/DSH installation required')
    env = {'PATH': str(Path(node).parent)+':/usr/bin:/bin', 'HOME': str(root/'user'),
           'DSH_HOME': str(root/'home'), 'DSH_TELEMETRY_DISABLED': '1',
           'XDG_CONFIG_HOME': str(root/'config'), 'XDG_DATA_HOME': str(root/'data'),
           'XDG_STATE_HOME': str(root/'state'), 'XDG_CACHE_HOME': str(root/'cache')}
    for key in ('HOME','DSH_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME'):
        Path(env[key]).mkdir(parents=True)
    work=root/'work'; (work/'corpus').mkdir(parents=True)
    for idx in (1,2):
        (work/f'corpus/f{idx}.txt').write_text(f'MOCKSTEP:smoke{idx}:1\nOFFLINE DSH INTEGRATION ONLY\n')
    def cmd(args):
        proc=subprocess.Popen(args, env=env, cwd=work, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout,stderr=proc.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            stdout,stderr=proc.communicate(timeout=10)
            raise RuntimeError('subprocess timed out; entire process group killed')
        return subprocess.CompletedProcess(args,proc.returncode,stdout,stderr)
    init=cmd([node,str(dsh),'--profile','headless','--dump-default-config'])
    (root/'bootstrap.log').write_text(init.stdout+init.stderr)
    if init.returncode:
        raise RuntimeError('DSH profile initialization failed')
    if a.arm=='plugin':
        profile=root/'home/profiles/headless'
        mods=profile/'node_modules'; mods.mkdir(exist_ok=True)
        (mods/'dsh-magic-context').symlink_to(repo/'packages/dsh-plugin', target_is_directory=True)
        (mods/'@deepseek-ai').symlink_to(install/'node_modules/@deepseek-ai', target_is_directory=True)
        toks=list(repo.glob('node_modules/.bun/ai-tokenizer@*/node_modules/ai-tokenizer'))
        if len(toks)!=1:
            raise RuntimeError('unambiguous ai-tokenizer required')
        (mods/'ai-tokenizer').symlink_to(toks[0],target_is_directory=True)
        setup=cmd([node,str(repo/'packages/dsh-plugin/dist/cli.js'),'setup','--profile','headless'])
        (root/'plugin-setup.log').write_text(setup.stdout+setup.stderr)
        if setup.returncode:
            raise RuntimeError('plugin setup failed')
    patch=root/'mock-routes.yml'
    patch.write_text('''- id: llm-pi-ai
  config:
    providers:
      longrun-mock:
        apiKeyEnv: MOCK_LLM_KEY
        api: openai-completions
        baseURL: http://longrun.invalid/r/main/w100000/v1
        headers:
          x-opencode-session: !!js process.env.OPENCODE_SESSION
        models:
          - id: mock-model
            contextWindow: 100000
            maxTokens: 4096
      longrun-hist:
        apiKeyEnv: MOCK_LLM_KEY
        api: openai-completions
        baseURL: http://longrun.invalid/r/hist/w200000/v1
        headers:
          x-opencode-session: !!js process.env.OPENCODE_SESSION
        models:
          - id: mock-model
            contextWindow: 200000
            maxTokens: 16384
- id: agent-default-model
  config:
    provider: longrun-mock
    model: mock-model
'''+('''- id: magic-agent
  config:
    historian:
      model: longrun-hist/mock-model
''' if a.arm=='plugin' else ''))
    plans={f'smoke{i}':[{'tool':'read','args':{'file_path':f'corpus/f{i}.txt'}},
                         {'text':json.dumps({'offline_smoke':i})}] for i in (1,2)}
    (root/'plans.json').write_text(json.dumps(plans))
    mock_env={**env,'MOCK_TOKENIZER_ROOT':str(repo/'packages/dsh-plugin')}
    socket_path=root/'gateway.sock'
    # Capability failure must occur before starting any mock child.
    gateway=Gateway(socket_path,a.mock_port,root/'gateway',seconds=120,max_calls=20)
    mocklog=(root/'mock.log').open('w')
    mock=subprocess.Popen([node,str(repo/'packages/dsh-plugin/scripts/e2e/mock-llm.mjs'),str(a.mock_port),
                           str(root/'plans.json'),str(root/'mock-requests.jsonl')],env=mock_env,
                          stdout=mocklog,stderr=subprocess.STDOUT,start_new_session=True)
    thread=threading.Thread(target=gateway.server.serve_forever,daemon=True); thread.start()
    try:
        for _ in range(100):
            if mock.poll() is not None: raise RuntimeError('mock exited before readiness')
            if 'listening' in (root/'mock.log').read_text(): break
            time.sleep(.1)
        else: raise RuntimeError('mock readiness timeout')
        env.update({'MOCK_LLM_KEY':'mock-not-a-secret','OPENCODE_SESSION':a.arm+'-offline-smoke',
                    'LONGRUN_MOCK_SOCKET':str(socket_path),
                    'NODE_OPTIONS':'--import='+str(HERE/'unix-fetch-bridge.mjs')})
        prefix=['unshare','--user','--map-root-user','--net','--pid','--fork','--mount-proc']
        # Probe native socket egress (not patched fetch), and isolated proc view.
        probe=cmd(prefix+['python3','-c',
            'import json,socket,os; s=socket.socket(); s.settimeout(1); '\
            'r={"routes":open("/proc/net/route").read(),"pids":[p for p in os.listdir("/proc") if p.isdigit()]}; '\
            '\ntry: s.connect(("1.1.1.1",443)); r["egress"]="UNEXPECTED_SUCCESS"'\
            '\nexcept OSError as e: r["errno"]=e.errno'\
            '\nprint(json.dumps(r))'])
        (root/'isolation.json').write_text(probe.stdout)
        isolation=json.loads(probe.stdout)
        if isolation.get('errno')!=101 or route_entries(isolation.get('routes')):
            raise RuntimeError('network isolation not proven')
        sid=None; results=[]
        for i in (1,2):
            args=prefix+[node,str(dsh),'--profile','headless','--patch',str(patch),
                f'Read corpus/f{i}.txt using the read tool. [[MOCK:smoke{i}]]','--json']
            if sid: args+=['--session-id',sid]
            run=cmd(args)
            log=run.stdout+run.stderr
            (root/f'turn-{i}.log').write_text(log)
            parsed=parse_turn(log,expected_session=sid,exit_code=run.returncode)
            if not parsed['cli_completed']: raise RuntimeError(f'DSH turn {i}: {parsed["errors"]}')
            if json.loads(parsed['answer'])!={'offline_smoke':i}: raise RuntimeError('unexpected mock answer')
            sid=parsed['session_id']; results.append(parsed)
        events,source=load_session(root/'home',sid)
        (root/'session.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in events))
        tools=executed_tools(events)
        snapshot, request_rows = gateway.seal_and_collect()
        errors, runtime = smoke_evidence_errors(a.arm, sid, results, tools, events, snapshot, request_rows)
        report={'origin':'real-dsh-with-local-mock','arm':a.arm,'real_model_calls':0,
            'live_ready':False,'efficacy_benchmark':False,'passed':not errors,'errors':errors,'isolation':isolation,
            'plugin_runtime':runtime,
            'turns':results,'executed_tools':tools,'native_compactions':native_compactions(events),
            'gateway':snapshot,'gateway_requests':request_rows,'note':'Short integration smoke only; synthetic ledger prices, zero actual model charge.'}
        (root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,indent=2))
        if errors:
            raise RuntimeError('smoke evidence validation failed: ' + '; '.join(errors))
    finally:
        gateway.server.shutdown(); thread.join(timeout=2); gateway.close()
        if mock.poll() is None:
            os.killpg(mock.pid,signal.SIGTERM)
        mock.wait(timeout=10); mocklog.close()


if __name__=='__main__': main()
