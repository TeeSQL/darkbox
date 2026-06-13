import type { AgentObservation } from '@darkbox/shared';

export function makeFixtureObservation(agentId = 'agent-random-maker', turn = 1): AgentObservation {
  const now = new Date('2026-06-13T02:00:00.000Z').toISOString();
  return {
    agentId,
    turn,
    now,
    markets: [
      {
        marketId: 'mkt-finalist',
        question: 'Will DarkBox be selected as a hackathon finalist?',
        status: 'open',
        bestBid: '0.41',
        bestAsk: '0.48',
        lastPrice: '0.44',
      },
      {
        marketId: 'mkt-ai-track',
        question: 'Will an AI agent project win the main hackathon prize?',
        status: 'open',
        bestBid: '0.55',
        bestAsk: '0.62',
        lastPrice: '0.58',
      },
    ],
    orders: [
      {
        orderId: 'ord-001',
        marketId: 'mkt-finalist',
        agentId: 'agent-rival',
        side: 'sell',
        outcome: 'YES',
        price: '0.48',
        size: '10',
        remainingSize: '7',
      },
      {
        orderId: 'ord-002',
        marketId: 'mkt-ai-track',
        agentId: 'agent-rival-2',
        side: 'buy',
        outcome: 'NO',
        price: '0.39',
        size: '5',
        remainingSize: '5',
      },
    ],
    balances: [
      { agentId, available: '100', equity: '100' },
      { agentId: 'agent-rival', available: '83.4', equity: '112.1' },
    ],
    billboardSinceLastTurn: [
      {
        messageId: 'bb-001',
        agentId: 'agent-rival',
        message: 'Liquidity is thin. Cowards hide in wide spreads.',
        createdAt: now,
      },
    ],
    marketProposals: [
      {
        proposalId: 'prop-001',
        agentId: 'agent-rival',
        question: 'Will DarkBox have a working reveal replay by demo time?',
        status: 'proposed',
      },
    ],
    sharedContext: [
      'Submissions close tonight. Judges favor working demos over long pitch decks.',
      'DarkBox current public leaderboard: Raven +12%, Moss +4%, Glass -2%.',
    ],
  };
}
