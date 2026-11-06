"""Read real DSH CLI/session evidence. No model/network invocation here."""
import json
from pathlib import Path
import re
import subprocess


def route_entries(text):
    """Return IPv4 route rows, excluding only the known /proc table header.

    Linux may emit a header even when the namespace has no routes. Unknown
    nonempty lines remain entries so malformed evidence cannot pass isolation.
    """
    if not isinstance(text, str):
        raise ValueError('route table must be text')
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and lines[0].split()[:3] == ['Iface', 'Destination', 'Gateway']:
        lines = lines[1:]
    return lines


def json_lines(text):
    rows = []
    for line in text.splitlines():
        if line.startswith('{'):
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def parse_turn(log, *, expected_session=None, exit_code=0):
    rows = json_lines(log)
    sessions = {r['sessionId'] for r in rows if r.get('type') == 'session' and r.get('sessionId')}
    finals = [r['text'] for r in rows if r.get('type') == 'final' and isinstance(r.get('text'), str)]
    ends = [r for r in rows if r.get('type') == 'status' and r.get('phase') == 'turn_end']
    errors = []
    if len(sessions) != 1:
        errors.append('missing/ambiguous session')
    sid = next(iter(sessions), None)
    if expected_session is not None and sid != expected_session:
        errors.append('resumed a different session')
    if len(finals) != 1:
        errors.append('missing/ambiguous final')
    if not ends or ends[-1].get('reason', {}).get('kind') != 'completed':
        errors.append('turn not completed')
    if exit_code != 0:
        errors.append(f'process exit {exit_code}')
    # Remove only the adapter's own documented leading transport tag, not prose.
    final = re.sub(r'^§\d+§\s*', '', finals[-1]) if finals else None
    return {'session_id': sid, 'answer': final, 'exit_code': exit_code,
            'cli_completed': not errors, 'errors': errors,
            'steps': sum(r.get('type') == 'status' and r.get('phase') == 'step_end' for r in rows)}


def load_session(dsh_home, session_id):
    if not re.fullmatch(r'session-[A-Za-z0-9-]+', session_id):
        raise ValueError('invalid session id')
    paths = list(Path(dsh_home).glob(f'sessions/*/{session_id}/session.v4.jsonl.zstd'))
    if len(paths) != 1:
        raise ValueError('session file missing or ambiguous')
    proc = subprocess.run(['zstd', '-qdc', str(paths[0])], capture_output=True, check=True, timeout=30)
    return json_lines(proc.stdout.decode('utf-8')), str(paths[0])


def executed_tools(events):
    results = {e.get('data', {}).get('callId'): e for e in events if e.get('type') == 'tool/result'}
    calls = []
    for event in events:
        if event.get('type') != 'tool/call':
            continue
        data = event.get('data', {})
        args = data.get('arguments', {})
        if isinstance(args, str):
            args = json.loads(args)
        call_id = data.get('callId')
        # tool/result stores the ID inside the message in current DSH v4.
        result = results.get(call_id) or next((e for e in events if e.get('type') == 'tool/result'
            and e.get('data', {}).get('message', {}).get('toolCallId') == call_id), None)
        calls.append({'name': data.get('name'), 'path': args.get('file_path', args.get('path')),
                      'turn': data.get('turn'), 'step': data.get('step'), 'call_id': call_id,
                      'seq': event.get('seq'), 'result_seq': result.get('seq') if result else None,
                      'completed': result is not None and not result.get('data', {}).get('message', {}).get('isError', False)})
    return calls


def native_compactions(events):
    groups = {}
    for event in events:
        if event.get('type', '').startswith('compaction/'):
            cid = event.get('data', {}).get('compactionId')
            if cid:
                groups.setdefault(cid, []).append(event)
    records = []
    for cid, rows in groups.items():
        kinds = {r['type'] for r in rows}
        errors = [r for r in rows if r['type'] == 'compaction/summary-error' or r.get('data', {}).get('error')]
        complete = {'compaction/start', 'compaction/summary', 'compaction/end'} <= kinds and not errors
        records.append({'id': cid, 'completed': complete, 'event_seqs': [r.get('seq') for r in rows],
                        'error': bool(errors), 'served_context_reduction_verified': False})
    return records


def tool_protocol_errors(calls, *, expected_turn=None):
    """Require actual successful results and strictly sequential file reads."""
    errors = []
    if not isinstance(calls, list):
        return ['tool calls are missing']
    ids = set()
    previous_seq = -1
    previous_read = None
    for index, call in enumerate(calls):
        if not isinstance(call, dict):
            errors.append(f'tool {index}: invalid record')
            continue
        cid = call.get('call_id')
        seq, result, step = (call.get(k) for k in ('seq', 'result_seq', 'step'))
        numeric = (type(seq) is int and seq >= 0 and type(result) is int and result > seq
                   and type(step) is int and step > 0)
        if (call.get('completed') is not True or not numeric or not isinstance(cid, str)
                or not cid or cid in ids):
            errors.append(f'tool {index}: missing or invalid completion evidence')
        if expected_turn is not None and (type(call.get('turn')) is not int or call['turn'] != expected_turn):
            errors.append(f'tool {index}: wrong turn')
        if isinstance(cid, str):
            ids.add(cid)
        if type(seq) is int:
            if seq <= previous_seq:
                errors.append(f'tool {index}: calls not in event order')
            previous_seq = seq
        if call.get('name') == 'read' and numeric:
            if previous_read is not None:
                prior_step, prior_result = previous_read
                if step <= prior_step or seq <= prior_result:
                    errors.append(f'tool {index}: reads were batched or result was not awaited')
            previous_read = (step, result)
    return errors


def plugin_runtime_evidence(events, session_id):
    """Use session-owned adapter events, never configuration/setup success alone."""
    headers = [e for e in events if e.get('type') == 'session']
    same_session = len(headers) == 1 and headers[0].get('id') == session_id
    seqs = []
    for event in events:
        if event.get('type') != 'user/message':
            continue
        source = event.get('data', {}).get('source', {})
        if (source.get('kind') == 'magic-context' and source.get('plugin') == 'magic-context'
                and type(event.get('seq')) is int and event['seq'] >= 0):
            seqs.append(event['seq'])
    return {'session_verified': same_session, 'runtime_event_seqs': seqs,
            'plugin_loaded': same_session and bool(seqs)}


def gateway_evidence_errors(snapshot, requests, minimum_calls=1):
    errors = []
    calls = snapshot.get('calls')
    if type(calls) is not int or calls < minimum_calls:
        errors.append('gateway missing expected calls')
    if snapshot.get('stopped') is not None or type(snapshot.get('unsettled')) is not int or snapshot['unsettled'] != 0:
        errors.append('gateway stopped or has unsettled calls')
    if not isinstance(requests, list):
        return errors + ['gateway request log missing']
    ids = [r.get('id') for r in requests]
    if len(requests) != calls or any(type(rid) is not int for rid in ids) or sorted(ids) != list(range(1, len(requests) + 1)):
        errors.append('gateway request log does not match ledger')
    for row in requests:
        usage = row.get('usage')
        if (row.get('state') != 'settled' or row.get('status') != 200 or not isinstance(usage, dict)
                or any(type(row.get(k)) is not int or row[k] < 0 for k in ('input_tokens', 'output_tokens'))
                or type(usage.get('prompt_tokens')) is not int or type(usage.get('completion_tokens')) is not int
                or usage.get('prompt_tokens') != row.get('input_tokens')
                or usage.get('completion_tokens') != row.get('output_tokens')):
            errors.append('gateway request lacks settled usage evidence')
            break
    return errors


def smoke_evidence_errors(arm, session_id, turns, tools, events, snapshot, requests):
    errors = []
    if len(turns) != 2 or any(not t.get('cli_completed') or t.get('session_id') != session_id for t in turns):
        errors.append('two completed turns on the same session required')
    if len(tools) != 2 or [t.get('path') for t in tools] != ['corpus/f1.txt', 'corpus/f2.txt']:
        errors.append('expected exactly the two smoke file reads')
    for index, call in enumerate(tools, 1):
        errors.extend(tool_protocol_errors([call], expected_turn=index))
        if call.get('name') != 'read':
            errors.append('unexpected smoke tool')
    runtime = plugin_runtime_evidence(events, session_id)
    if not runtime['session_verified']:
        errors.append('session header mismatch')
    if arm == 'plugin' and not runtime['plugin_loaded']:
        errors.append('plugin runtime loading is unverified')
    if arm == 'baseline' and runtime['runtime_event_seqs']:
        errors.append('baseline contains plugin runtime events')
    errors.extend(gateway_evidence_errors(snapshot, requests, minimum_calls=max(4, sum(t.get('steps', 0) for t in turns))))
    return errors, runtime
