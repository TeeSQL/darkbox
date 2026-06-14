"""Unit tests for the deterministic non-trading action policy (billboards +
market proposals) added on top of Dan's event-driven agents."""
import unittest
from datetime import datetime, timezone

from services.agents.event_agents.indexer_adapter import build_agent_turn_body
from services.agents.event_agents.models import AgentIdentity, AgentPolicy, MarketEvent, Observation, OwnerBinding
from services.agents.event_agents.policy import (
    DEFAULT_CONFIG,
    PolicyConfig,
    PolicyState,
    classify_market,
    evaluate_billboard,
    evaluate_proposal,
    normalize_question,
    sanitize_billboard,
)
from services.agents.event_agents.strategy import decide

NOW = datetime(2026, 6, 13, 2, 0, 0, tzinfo=timezone.utc)
FUTURE = '2026-06-20T00:00:00Z'

GOOD_PROPOSAL = {
    'question': 'Will at least 10 projects mention Base?',
    'description': 'Sponsor adoption count.',
    'outcomes': ['YES', 'NO'],
    'resolveBy': FUTURE,
    'resolutionSource': 'ETHGlobal public submissions',
    'rationale': 'Public sponsor-count edge.',
}


def state_at(seq, **kw):
    s = PolicyState(initialized=True)
    s.seq = seq
    for k, v in kw.items():
        setattr(s, k, v)
    return s


class BillboardTriggerTests(unittest.TestCase):
    def test_no_trigger_drops(self):
        s = state_at(10, last_billboard_seq=9)
        d = evaluate_billboard('hi', [], False, False, s)
        self.assertFalse(d['allowed'])
        self.assertEqual(d['rejectReason'], 'no_trigger')

    def test_trade_action_trigger(self):
        s = state_at(10, last_billboard_seq=None)
        d = evaluate_billboard('Bidding YES.', ['make_order'], False, False, s)
        self.assertTrue(d['allowed'])
        self.assertIn('trade_action', d['triggers'])

    def test_rival_response_trigger(self):
        s = state_at(10, last_billboard_seq=None)
        d = evaluate_billboard('Come take the other side.', [], True, False, s)
        self.assertTrue(d['allowed'])
        self.assertIn('rival_response', d['triggers'])

    def test_market_live_trigger(self):
        s = state_at(10, last_billboard_seq=None)
        d = evaluate_billboard('New market live.', [], False, True, s)
        self.assertTrue(d['allowed'])
        self.assertIn('market_live', d['triggers'])

    def test_periodic_only_after_interval(self):
        cfg = DEFAULT_CONFIG
        too_soon = evaluate_billboard('tick', [], False, False, state_at(10, last_billboard_seq=10 - (cfg.billboard_periodic_events - 1)), cfg)
        self.assertFalse(too_soon['allowed'])
        due = evaluate_billboard('tick', [], False, False, state_at(10, last_billboard_seq=10 - cfg.billboard_periodic_events), cfg)
        self.assertTrue(due['allowed'])
        self.assertIn('periodic', due['triggers'])

    def test_cooldown_blocks_back_to_back(self):
        cfg = PolicyConfig(billboard_cooldown_events=2)
        d = evaluate_billboard('again', ['make_order'], False, False, state_at(10, last_billboard_seq=9), cfg)
        self.assertFalse(d['allowed'])
        self.assertEqual(d['rejectReason'], 'cooldown')

    def test_no_billboard_every_event_over_a_loop(self):
        cfg = DEFAULT_CONFIG
        identity = AgentIdentity('ash', '0xabc', '0xdef')
        binding = OwnerBinding('0x1', '0xowner', 'ash', '0xabc', '0xdef', 'registered')
        policy = AgentPolicy.from_json('ash', {'fairValues': {'m1': 0.58}, 'billboardStyle': 'punchy'})
        observation = Observation.from_json({
            'markets': [{'marketId': 'm1', 'question': 'Will DarkBox finalist?', 'status': 'open', 'bestBid': '0.40', 'bestAsk': '0.50'}],
            'orders': [], 'portfolio': {'cash': '100', 'equity': '100', 'positions': []},
        })
        state = PolicyState()
        posted = []
        for i in range(12):
            result = decide(MarketEvent.from_json({'eventId': f'e{i}', 'type': 'orderbook_changed', 'marketId': 'm1'}), identity, binding, policy, observation, state=state, config=cfg)
            state = PolicyState.from_json(result['policyState'])
            if result['billboardPost']:
                posted.append(i)
        for a, b in zip(posted, posted[1:]):
            self.assertGreaterEqual(b - a, cfg.billboard_cooldown_events, f'posts {a},{b} violate cooldown')
        self.assertGreaterEqual(len(posted), 3, 'expected several posts (liveness)')


class BillboardSanitizeTests(unittest.TestCase):
    def test_trims_and_collapses(self):
        r = sanitize_billboard('  hello   world  ')
        self.assertTrue(r['ok'])
        self.assertEqual(r['message'], 'hello world')

    def test_truncates(self):
        r = sanitize_billboard('a' * 400, PolicyConfig(billboard_max_length=10))
        self.assertTrue(r['ok'])
        self.assertLessEqual(len(r['message']), 10)

    def test_rejects_hidden_state(self):
        leaks = [
            'wallet 0x1234567890abcdef1234567890abcdef12345678',
            'shadow_account leak',
            'my private key is x',
            'dumping v0:book:m1:yes',
            'PORTFOLIO={cash:90}',
            'avgEntry 0.3 realizedPnl 4',
            'current_balance 991',
            'state {"size":"5","avgEntry":"0.3","price":"0.4"}',
            '0x' + 'a' * 64,
        ]
        for msg in leaks:
            r = sanitize_billboard(msg)
            self.assertFalse(r['ok'], f'should reject: {msg}')
            self.assertEqual(r['reason'], 'hidden_state_leak')

    def test_normal_ad_passes(self):
        self.assertTrue(sanitize_billboard('New Blink market live. Selling NO cheap.')['ok'])

    def test_leaky_billboard_dropped_even_with_trigger(self):
        s = state_at(10, last_billboard_seq=None)
        d = evaluate_billboard('filled at 0x1234567890abcdef1234567890abcdef12345678', ['make_order'], False, False, s)
        self.assertFalse(d['allowed'])
        self.assertEqual(d['rejectReason'], 'hidden_state_leak')


class ProposalPolicyTests(unittest.TestCase):
    def test_good_objective_allowed(self):
        d = evaluate_proposal(GOOD_PROPOSAL, [], PolicyState(), NOW)
        self.assertTrue(d['allowed'])
        self.assertTrue(d['adminQueueOnly'])
        self.assertEqual(d['family'], 'ethglobal_metric')

    def test_subjective_rejected(self):
        d = evaluate_proposal({**GOOD_PROPOSAL, 'question': 'Which project has the best UX?'}, [], PolicyState(), NOW)
        self.assertFalse(d['allowed'])
        self.assertEqual(d['rejectReason'], 'subjective')

    def test_unresolvable_rejected(self):
        d = evaluate_proposal({**GOOD_PROPOSAL, 'question': 'Will it rain during the hackathon?'}, [], PolicyState(), NOW)
        self.assertFalse(d['allowed'])
        self.assertEqual(d['rejectReason'], 'unresolvable')

    def test_missing_source_rejected(self):
        d = evaluate_proposal({**GOOD_PROPOSAL, 'resolutionSource': ' '}, [], PolicyState(), NOW)
        self.assertEqual(d['rejectReason'], 'missing_resolution_source')

    def test_past_date_rejected(self):
        d = evaluate_proposal({**GOOD_PROPOSAL, 'resolveBy': '2020-01-01T00:00:00Z'}, [], PolicyState(), NOW)
        self.assertEqual(d['rejectReason'], 'resolve_by_not_future')

    def test_unparseable_date_rejected(self):
        d = evaluate_proposal({**GOOD_PROPOSAL, 'resolveBy': 'whenever'}, [], PolicyState(), NOW)
        self.assertEqual(d['rejectReason'], 'resolve_by_unparseable')

    def test_not_yes_no_rejected(self):
        d = evaluate_proposal({**GOOD_PROPOSAL, 'outcomes': ['UP', 'DOWN']}, [], PolicyState(), NOW)
        self.assertEqual(d['rejectReason'], 'not_yes_no')

    def test_duplicate_vs_existing(self):
        d = evaluate_proposal(GOOD_PROPOSAL, ['Will at least 10 projects mention BASE??'], PolicyState(), NOW)
        self.assertEqual(d['rejectReason'], 'duplicate')

    def test_duplicate_vs_own_state(self):
        s = PolicyState(proposed_questions=[normalize_question(GOOD_PROPOSAL['question'])])
        d = evaluate_proposal(GOOD_PROPOSAL, [], s, NOW)
        self.assertEqual(d['rejectReason'], 'duplicate')

    def test_cooldown(self):
        cfg = PolicyConfig(proposal_cooldown_events=5)
        s = state_at(2, last_proposal_seq=0)
        d = evaluate_proposal(GOOD_PROPOSAL, [], s, NOW, cfg)
        self.assertEqual(d['rejectReason'], 'cooldown')

    def test_budget(self):
        cfg = PolicyConfig(proposal_budget_per_agent=2)
        s = PolicyState(proposals_made=2)
        d = evaluate_proposal(GOOD_PROPOSAL, [], s, NOW, cfg)
        self.assertEqual(d['rejectReason'], 'budget_exhausted')

    def test_admin_queue_only_flag_always_set(self):
        self.assertTrue(evaluate_proposal(GOOD_PROPOSAL, [], PolicyState(), NOW)['adminQueueOnly'])
        self.assertTrue(evaluate_proposal({**GOOD_PROPOSAL, 'question': 'best vibes?'}, [], PolicyState(), NOW)['adminQueueOnly'])


class StrategyIntegrationTests(unittest.TestCase):
    IDENTITY = AgentIdentity('hex', '0xabc', '0xdef')
    BINDING = OwnerBinding('0x1', '0xowner', 'hex', '0xabc', '0xdef', 'registered')

    def _obs(self):
        return Observation.from_json({
            'markets': [{'marketId': 'm1', 'question': 'Will DarkBox finalist?', 'status': 'open', 'bestBid': '0.40', 'bestAsk': '0.50'}],
            'orders': [], 'portfolio': {'cash': '100', 'equity': '100', 'positions': []}, 'now': '2026-06-13T02:00:00Z',
        })

    def test_decide_emits_objective_proposal_from_policy_candidate(self):
        policy = AgentPolicy.from_json('hex', {'fairValues': {'m1': 0.58}, 'proposalCandidates': [GOOD_PROPOSAL]})
        event = MarketEvent.from_json({'eventId': 'e1', 'type': 'market_created', 'marketId': 'm1'})
        result = decide(event, self.IDENTITY, self.BINDING, policy, self._obs(), state=PolicyState())
        self.assertIsNotNone(result['marketProposal'])
        self.assertEqual(result['marketProposal']['outcomes'], ['YES', 'NO'])
        self.assertTrue(result['policy']['proposal']['allowed'])

    def test_decide_drops_subjective_proposal_candidate(self):
        policy = AgentPolicy.from_json('hex', {'fairValues': {'m1': 0.58}, 'proposalCandidates': [{**GOOD_PROPOSAL, 'question': 'Which demo is the most beautiful?'}]})
        event = MarketEvent.from_json({'eventId': 'e1', 'type': 'market_created', 'marketId': 'm1'})
        result = decide(event, self.IDENTITY, self.BINDING, policy, self._obs(), state=PolicyState())
        self.assertIsNone(result['marketProposal'])
        self.assertEqual(result['policy']['proposal']['rejectReason'], 'subjective')

    def test_decide_advances_state_and_is_dry_run(self):
        policy = AgentPolicy.from_json('hex', {'fairValues': {'m1': 0.58}})
        event = MarketEvent.from_json({'eventId': 'e1', 'type': 'orderbook_changed', 'marketId': 'm1'})
        result = decide(event, self.IDENTITY, self.BINDING, policy, self._obs(), state=PolicyState())
        self.assertEqual(result['policyState']['seq'], 1)
        self.assertEqual(result['executor']['mode'], 'dry_run')


class AdapterTests(unittest.TestCase):
    def test_build_agent_turn_body_maps_surfaces(self):
        identity = AgentIdentity('ash', '0xAddr', '0xShadow')
        decision = {
            'ok': True,
            'tradeActions': [{'type': 'make_order', 'marketId': 'm1', 'side': 'buy', 'outcome': 'YES', 'price': '0.45', 'size': '2', 'timeInForce': 'GTC'}],
            'billboardPost': {'message': 'Bidding YES.'},
            'marketProposal': GOOD_PROPOSAL,
            'reason': 'x',
        }
        body = build_agent_turn_body('run-1', 3, identity, decision)
        self.assertEqual(body['agentId'], 'ash')
        self.assertEqual(body['turn'], 3)
        self.assertEqual(body['identity']['shadowAccount'], '0xShadow')
        self.assertEqual(body['output']['billboardPost']['message'], 'Bidding YES.')
        self.assertEqual(body['output']['marketProposal']['question'], GOOD_PROPOSAL['question'])


if __name__ == '__main__':
    unittest.main()
