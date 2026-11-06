import json
import unittest
from dsh_adapter import executed_tools, native_compactions, parse_turn, route_entries, smoke_evidence_errors
from mock_gateway import parse_usage


class RouteTableTests(unittest.TestCase):
    HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n'
    DEFAULT = 'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0'
    CONNECTED = 'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0'

    def test_empty_route_table(self):
        self.assertEqual(route_entries(''), [])
        self.assertEqual(route_entries(' \n\t\n'), [])

    def test_header_only_means_no_routes(self):
        self.assertEqual(route_entries(self.HEADER), [])
        self.assertEqual(route_entries('\n' + self.HEADER + '\n'), [])

    def test_header_with_real_routes_is_not_empty(self):
        self.assertEqual(route_entries(self.HEADER + self.DEFAULT + '\n' + self.CONNECTED + '\n'),
                         [self.DEFAULT, self.CONNECTED])

    def test_headerless_route_is_never_discarded(self):
        self.assertEqual(route_entries(self.DEFAULT + '\n'), [self.DEFAULT])

    def test_unknown_or_missing_route_evidence_fails_closed(self):
        self.assertEqual(route_entries('unexpected data\n'), ['unexpected data'])
        with self.assertRaises(ValueError):
            route_entries(None)


class AdapterTests(unittest.TestCase):
    def log(self):
        return '\n'.join(json.dumps(r) for r in [
            {'type':'session','sessionId':'session-test'},
            {'type':'status','phase':'step_end','usage':{'inputTokens':10,'outputTokens':2}},
            {'type':'status','phase':'turn_end','reason':{'kind':'completed'}},
            {'type':'final','text':'§12§ {"ready":true}'}])

    def test_parse_cli_and_leading_adapter_tag(self):
        r=parse_turn(self.log(),expected_session='session-test')
        self.assertTrue(r['cli_completed'])
        self.assertEqual(json.loads(r['answer']),{'ready':True})
        self.assertEqual(r['steps'],1)

    def test_wrong_session_exit_and_missing_final_fail(self):
        self.assertFalse(parse_turn(self.log(),expected_session='session-other')['cli_completed'])
        self.assertFalse(parse_turn(self.log(),exit_code=124)['cli_completed'])
        self.assertFalse(parse_turn(self.log().rsplit('\n',1)[0])['cli_completed'])

    def test_duplicate_final_is_not_silently_accepted(self):
        self.assertFalse(parse_turn(self.log()+'\n'+json.dumps({'type':'final','text':'other'}))['cli_completed'])

    def test_real_v4_tool_result_shape(self):
        events=[{'type':'tool/call','seq':29,'data':{'turn':2,'step':1,'callId':'c1','name':'read',
                'arguments':'{"file_path":"corpus/f.txt"}'}},
                {'type':'tool/result','seq':30,'data':{'message':{'toolCallId':'c1','isError':False}}}]
        calls=executed_tools(events)
        self.assertTrue(calls[0]['completed'])
        self.assertEqual(calls[0]['path'],'corpus/f.txt')
        self.assertEqual(calls[0]['result_seq'],30)
        events[1]['data']['message']['isError']=True
        self.assertFalse(executed_tools(events)[0]['completed'])

    def test_tool_call_without_result_does_not_count(self):
        events=[{'type':'tool/call','seq':1,'data':{'name':'read','callId':'missing','arguments':{}}}]
        self.assertFalse(executed_tools(events)[0]['completed'])

    def test_compaction_needs_start_summary_end_and_no_error(self):
        events=[{'type':f'compaction/{k}','seq':n,'data':{'compactionId':'abc'}}
                for n,k in enumerate(['start','summary','end'])]
        r=native_compactions(events)[0]
        self.assertTrue(r['completed'])
        self.assertFalse(r['served_context_reduction_verified'])
        self.assertFalse(native_compactions(events[:-1])[0]['completed'])
        events[-1]['data']['error']='busy'
        self.assertFalse(native_compactions(events)[0]['completed'])

    def test_json_usage_and_sse_usage(self):
        u={'prompt_tokens':12,'completion_tokens':4}
        self.assertEqual(parse_usage(json.dumps({'usage':u}).encode(),'application/json'),(u,12,4))
        raw=('data: {"choices":[]}\n\ndata: '+json.dumps({'usage':u})+'\n\ndata: [DONE]\n\n').encode()
        self.assertEqual(parse_usage(raw,'text/event-stream'),(u,12,4))

    def test_truncated_sse_unknown_usage_is_not_zero(self):
        for raw in (b'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n', b'data: [DONE]\n'):
            with self.assertRaises(ValueError):
                parse_usage(raw,'text/event-stream')
        with self.assertRaises(KeyError):
            parse_usage(b'{}','application/json')


class SmokeEvidenceTests(unittest.TestCase):
    def fixture(self, arm='plugin'):
        sid = 'session-test'
        turns = [{'cli_completed': True, 'session_id': sid, 'steps': 2} for _ in range(2)]
        tools = [{'name': 'read', 'path': f'corpus/f{i}.txt', 'completed': True, 'turn': i,
                  'step': 1, 'call_id': f'c{i}', 'seq': i * 10, 'result_seq': i * 10 + 1} for i in (1, 2)]
        events = [{'type': 'session', 'id': sid}, {'type': 'user/message', 'seq': 4,
                   'data': {'source': {'kind': 'magic-context', 'plugin': 'magic-context'}}}]
        if arm == 'baseline':
            events.pop()
        snapshot = {'calls': 4, 'unsettled': 0, 'stopped': None}
        requests = [{'id': i, 'status': 200, 'state': 'settled', 'input_tokens': 12, 'output_tokens': 4,
                     'usage': {'prompt_tokens': 12, 'completion_tokens': 4}} for i in range(1, 5)]
        return [arm, sid, turns, tools, events, snapshot, requests]

    def test_valid_normalized_smoke_evidence(self):
        for arm in ('plugin', 'baseline'):
            errors, runtime = smoke_evidence_errors(*self.fixture(arm))
            self.assertEqual(errors, [])
            self.assertEqual(runtime['plugin_loaded'], arm == 'plugin')

    def test_config_or_setup_alone_does_not_prove_plugin_loaded(self):
        args = self.fixture()
        args[4] = [{'type': 'session', 'id': args[1]},
                   {'type': 'setup', 'plugin': 'magic-context', 'success': True}]
        errors, runtime = smoke_evidence_errors(*args)
        self.assertIn('plugin runtime loading is unverified', errors)
        self.assertFalse(runtime['plugin_loaded'])

    def test_magic_event_from_wrong_session_does_not_prove_loading(self):
        args = self.fixture()
        args[4][0]['id'] = 'session-other'
        errors, runtime = smoke_evidence_errors(*args)
        self.assertIn('session header mismatch', errors)
        self.assertFalse(runtime['plugin_loaded'])

    def test_baseline_cannot_contain_magic_runtime(self):
        args = self.fixture()
        args[0] = 'baseline'
        errors, _ = smoke_evidence_errors(*args)
        self.assertIn('baseline contains plugin runtime events', errors)

    def test_smoke_rejects_stopped_or_unsettled_gateway(self):
        for update in ({'unsettled': 1}, {'stopped': 'unknown usage'}, {'calls': 0}):
            args = self.fixture()
            args[5].update(update)
            self.assertTrue(smoke_evidence_errors(*args)[0])

    def test_concurrent_completion_order_is_allowed_but_duplicate_ids_fail(self):
        args = self.fixture()
        args[6].reverse()
        self.assertEqual(smoke_evidence_errors(*args)[0], [])
        args[6][0]['id'] = args[6][1]['id']
        self.assertTrue(smoke_evidence_errors(*args)[0])

    def test_smoke_rejects_missing_log_or_unknown_usage(self):
        for change in ('missing', 'uncertain', 'usage'):
            args = self.fixture()
            if change == 'missing':
                args[6].pop()
            elif change == 'uncertain':
                args[6][0]['state'] = 'uncertain'
            else:
                args[6][0]['usage'] = None
            self.assertTrue(smoke_evidence_errors(*args)[0])

    def test_smoke_rejects_incomplete_read_even_with_correct_answer(self):
        args = self.fixture()
        args[3][0]['result_seq'] = None
        self.assertTrue(smoke_evidence_errors(*args)[0])


if __name__=='__main__': unittest.main()
