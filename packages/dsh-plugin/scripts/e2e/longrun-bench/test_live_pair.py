import unittest
from live_pair import judge_turn, observed_usage

class LivePairTests(unittest.TestCase):
    def test_missing_usage_not_success(self):
        r=observed_usage([{'status':200,'usage':None}])
        self.assertEqual(r['missing_usage'],1)
        self.assertFalse(r['all_calls_captured'])
        self.assertFalse(r['hard_dollar_guarantee'])
    def test_estimate_and_raw_list_cost_distinguished(self):
        r=observed_usage([{'kind':'historian','status':200,'usage':{'prompt_tokens':1000,'prompt_cache_hit_tokens':800,'completion_tokens':100,'opencode':{'list_cost':.02}}}])
        self.assertAlmostEqual(r['estimate_usd'],.0001848)
        self.assertEqual(r['opencode_list_cost'],.02)
        self.assertEqual(r['kinds'],{'historian':1})
    def test_correct_answer_does_not_erase_failed_completion(self):
        r=judge_turn({'kind':'checkpoint'},'{"a":1}',{'a':1},[],False)
        self.assertTrue(r['quality_pass']); self.assertFalse(r['protocol_pass'])
    def test_checkpoint_source_reread_fails_protocol(self):
        c={'name':'read','path':'corpus/a','seq':2,'result_seq':3,'step':1,'call_id':'c','completed':True}
        r=judge_turn({'kind':'checkpoint'},'{"a":1}',{'a':1},[c],True)
        self.assertFalse(r['protocol_pass'])
    def test_bad_json_is_quality_failure(self):
        self.assertFalse(judge_turn({},'invalid',{},[],True)['quality_pass'])

if __name__=='__main__': unittest.main()
