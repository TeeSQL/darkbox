import unittest

from services.agents.event_agents.models import AgentIdentity, AgentPolicy, MarketEvent, Observation, OwnerBinding
from services.agents.event_agents.strategy import decide

IDENTITY = AgentIdentity('murmur', '0x79c306936eFe2995cFcF70D5eBb56810223d7D95', '0x00000000000000000000000079c306936efe2995cfcf70d5ebb56810223d7d95')
BINDING = OwnerBinding('0x' + '01'.zfill(64), '0x000000000000000000000000000000000000dead', 'murmur', IDENTITY.address.lower(), IDENTITY.shadowAccount)


def obs(**kwargs):
    base = {
        'markets': [{'marketId': 'm1', 'question': 'Will DarkBox finalist?', 'status': 'open', 'bestBid': '0.40', 'bestAsk': '0.50', 'lastPrice': '0.45'}],
        'orders': [],
        'portfolio': {'cash': '100', 'equity': '100', 'positions': []},
    }
    base.update(kwargs)
    return Observation.from_json(base)


def event(kind='orderbook_changed'):
    return MarketEvent.from_json({'eventId': 'evt-1', 'type': kind, 'at': '2026-06-13T00:00:00Z', 'marketId': 'm1'})


class EventAgentsTest(unittest.TestCase):
    def test_missing_binding_holds(self):
        result = decide(event(), IDENTITY, None, AgentPolicy.from_json('murmur', {}), obs())
        self.assertFalse(result['ok'])
        self.assertEqual(result['tradeActions'][0]['type'], 'hold')

    def test_quotes_when_no_edge_to_take(self):
        result = decide(event(), IDENTITY, BINDING, AgentPolicy.from_json('murmur', {'fairValues': {'m1': 0.58}}), obs())
        self.assertTrue(result['ok'])
        self.assertTrue(any(action['type'] == 'make_order' for action in result['tradeActions']))
        self.assertTrue(all('actionId' in action for action in result['tradeActions']))

    def test_takes_mispriced_sell_order(self):
        observation = obs(orders=[{'orderId': 'o1', 'marketId': 'm1', 'agentId': 'rival', 'side': 'sell', 'outcome': 'YES', 'price': '0.35', 'size': '5', 'remainingSize': '5'}])
        result = decide(event(), IDENTITY, BINDING, AgentPolicy.from_json('murmur', {'fairValues': {'m1': 0.55}, 'minEdgeToTake': 0.08}), observation)
        self.assertEqual(result['tradeActions'][0]['type'], 'take_order')
        self.assertEqual(result['tradeActions'][0]['orderId'], 'o1')

    def test_take_profit_quotes_sell(self):
        observation = obs(portfolio={'cash': '90', 'equity': '110', 'positions': [{'marketId': 'm1', 'outcome': 'YES', 'size': '6', 'avgEntry': '0.35'}]})
        result = decide(event(), IDENTITY, BINDING, AgentPolicy.from_json('murmur', {'fairValues': {'m1': 0.55}, 'takeProfitEdge': 0.1}), observation)
        self.assertTrue(any(action['type'] == 'make_order' and action['side'] == 'sell' for action in result['tradeActions']))


if __name__ == '__main__':
    unittest.main()
