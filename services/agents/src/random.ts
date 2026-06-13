import type { AgentObservation, AgentTurnOutput, OrderSnapshot, TradeAction } from '@darkbox/shared';

export type RandomAgentKind =
  | 'random-holder'
  | 'random-maker'
  | 'random-taker'
  | 'random-split-merge'
  | 'random-market-proposer'
  | 'random-billboarder'
  | 'random-mixed';

export interface StrategyModule {
  name: string;
  decide(observation: AgentObservation): Promise<AgentTurnOutput> | AgentTurnOutput;
}

function pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('cannot pick from empty array');
  return items[Math.floor(Math.random() * items.length)]!;
}

function decimal(min: number, max: number, digits = 2): string {
  return (min + Math.random() * (max - min)).toFixed(digits);
}

function openOrders(observation: AgentObservation): OrderSnapshot[] {
  return observation.orders.filter((order) => Number(order.remainingSize) > 0);
}

function makeRandomOrder(observation: AgentObservation): TradeAction {
  const market = pick(observation.markets.filter((candidate) => candidate.status === 'open'));
  return {
    type: 'make_order',
    marketId: market.marketId,
    side: pick(['buy', 'sell'] as const),
    outcome: pick(['YES', 'NO'] as const),
    price: decimal(0.05, 0.95),
    size: decimal(1, 12),
    timeInForce: pick(['GTC', 'IOC', 'FOK'] as const),
  };
}

function takeRandomOrder(observation: AgentObservation): TradeAction {
  const order = pick(openOrders(observation));
  return {
    type: 'take_order',
    marketId: order.marketId,
    orderId: order.orderId,
    size: decimal(0.1, Math.max(0.2, Number(order.remainingSize))),
    maxPrice: order.side === 'sell' ? order.price : undefined,
    minPrice: order.side === 'buy' ? order.price : undefined,
  };
}

function splitOrMerge(observation: AgentObservation): TradeAction {
  const market = pick(observation.markets.filter((candidate) => candidate.status === 'open'));
  return {
    type: pick(['split', 'merge'] as const),
    marketId: market.marketId,
    amount: decimal(1, 8),
  };
}

function maybeBillboard(kind: RandomAgentKind): AgentTurnOutput['billboardPost'] {
  const messages = [
    `${kind}: spreads tell stories; I'm listening.`,
    `${kind}: if you can see my trade, it's already too late.`,
    `${kind}: requesting more chaos from the market gods.`,
    `${kind}: liquidity is a rumor, conviction is real.`,
  ];
  return Math.random() < 0.7 ? { message: pick(messages) } : null;
}

function proposal(): NonNullable<AgentTurnOutput['marketProposal']> {
  return {
    question: pick([
      'Will DarkBox ship a working local replay before demo time?',
      'Will an agent-created market become the highest-volume market?',
      'Will the top-ranked agent change during the final hour?',
    ]),
    description: 'Agent-generated binary market proposal. Requires admin approval before deployment.',
    outcomes: ['YES', 'NO'],
    resolveBy: '2026-06-14T23:59:00.000Z',
    resolutionSource: 'DarkBox operator/admin decision using revealed game artifacts.',
    rationale: 'This creates another tradeable signal around the demo narrative.',
  };
}

export function createRandomStrategy(kind: RandomAgentKind): StrategyModule {
  return {
    name: kind,
    decide(observation) {
      const tradeActions: TradeAction[] = [];
      let marketProposal: AgentTurnOutput['marketProposal'] = null;

      if (kind === 'random-holder') {
        tradeActions.push({ type: 'hold', reason: 'Preserving dry powder this turn.' });
      } else if (kind === 'random-maker') {
        tradeActions.push(makeRandomOrder(observation));
      } else if (kind === 'random-taker') {
        if (openOrders(observation).length > 0) tradeActions.push(takeRandomOrder(observation));
        else tradeActions.push({ type: 'hold', reason: 'No visible liquidity to take.' });
      } else if (kind === 'random-split-merge') {
        tradeActions.push(splitOrMerge(observation));
      } else if (kind === 'random-market-proposer') {
        tradeActions.push({ type: 'hold', reason: 'Spending this turn on market design.' });
        marketProposal = proposal();
      } else if (kind === 'random-billboarder') {
        tradeActions.push({ type: 'hold', reason: 'Choosing words over trades this turn.' });
      } else {
        const choice = pick(['make', 'take', 'splitMerge', 'proposal', 'hold'] as const);
        if (choice === 'make') tradeActions.push(makeRandomOrder(observation));
        if (choice === 'take') tradeActions.push(openOrders(observation).length > 0 ? takeRandomOrder(observation) : makeRandomOrder(observation));
        if (choice === 'splitMerge') tradeActions.push(splitOrMerge(observation));
        if (choice === 'proposal') {
          tradeActions.push({ type: 'hold', reason: 'Proposing a new surface instead of trading.' });
          marketProposal = proposal();
        }
        if (choice === 'hold') tradeActions.push({ type: 'hold', reason: 'Waiting for a better signal.' });
      }

      return {
        tradeActions,
        billboardPost: maybeBillboard(kind),
        marketProposal,
        reason: `${kind} generated a valid random turn from full indexer state.`,
      };
    },
  };
}

export const randomStrategyKinds: RandomAgentKind[] = [
  'random-holder',
  'random-maker',
  'random-taker',
  'random-split-merge',
  'random-market-proposer',
  'random-billboarder',
  'random-mixed',
];
