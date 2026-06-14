import {
  parseAgentObservation,
  type AgentObservation,
  type AgentTurnOutput,
  type OrderSnapshot,
  type TradeAction,
} from '@darkbox/shared';
import type { StrategyModule } from './random.js';
import { validateTurnOutput } from './validate.js';

export interface IndexerClientOptions {
  internalUrl?: string;
  internalToken?: string;
}

/** Thin HTTP client for the indexer internal API used by the live runner. */
export class IndexerClient {
  private readonly base: string;
  private readonly token?: string;

  constructor(options: IndexerClientOptions = {}) {
    this.base = (options.internalUrl ?? process.env.INDEXER_INTERNAL_URL ?? 'http://darkbox-indexer:8080/internal').replace(/\/$/, '');
    this.token = options.internalToken ?? process.env.INTERNAL_API_TOKEN;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { 'x-internal-token': this.token } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      headers: this.token ? { 'x-internal-token': this.token } : {},
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
    return JSON.parse(text);
  }

  registerIdentity(body: { shadowAccount: string; agentId: string; source: 'human' | 'spawned' }): Promise<unknown> {
    return this.post('/identity', body);
  }

  async createMarket(marketId: string, question: string): Promise<void> {
    try {
      await this.post('/markets', { marketId, question });
    } catch (error) {
      // Idempotent: ignore "market exists".
      if (!(error instanceof Error && /exists/.test(error.message))) throw error;
    }
  }

  deposit(agentId: string, amount: number): Promise<unknown> {
    return this.post('/deposits', { agentId, amount });
  }

  async observation(agentId: string, turn: number): Promise<AgentObservation> {
    const body = (await this.get(`/agents/${encodeURIComponent(agentId)}/observation?turn=${turn}`)) as {
      observation: unknown;
    };
    return parseAgentObservation(body.observation);
  }

  placeOrder(input: Record<string, unknown>): Promise<unknown> {
    return this.post('/orders', input);
  }

  cancelOrder(orderId: string, agentId: string): Promise<unknown> {
    return this.post('/orders/cancel', { orderId, agentId });
  }

  split(agentId: string, marketId: string, amount: number): Promise<unknown> {
    return this.post('/split', { agentId, marketId, amount });
  }

  merge(agentId: string, marketId: string, amount: number): Promise<unknown> {
    return this.post('/merge', { agentId, marketId, amount });
  }

  leaderboard(): Promise<{ entries: unknown[] }> {
    return this.get('/leaderboard/raw') as Promise<{ entries: unknown[] }>;
  }
}

/** Translate a single validated trade action into indexer calls. */
async function applyAction(
  client: IndexerClient,
  agentId: string,
  action: TradeAction,
  ordersById: Map<string, OrderSnapshot>,
): Promise<string> {
  switch (action.type) {
    case 'make_order':
      await client.placeOrder({
        agentId,
        marketId: action.marketId,
        outcome: action.outcome,
        side: action.side,
        price: action.price,
        size: action.size,
        timeInForce: action.timeInForce,
      });
      return `make ${action.side} ${action.outcome} ${action.size}@${action.price}`;
    case 'take_order': {
      // A take is a marketable IOC limit that crosses the resting order.
      const resting = ordersById.get(action.orderId);
      if (!resting) return `skip take (order ${action.orderId} not visible)`;
      const side = resting.side === 'sell' ? 'buy' : 'sell';
      const price = side === 'buy' ? action.maxPrice ?? resting.price : action.minPrice ?? resting.price;
      await client.placeOrder({
        agentId,
        marketId: resting.marketId,
        outcome: resting.outcome,
        side,
        price,
        size: action.size,
        timeInForce: 'IOC',
      });
      return `take ${side} ${resting.outcome} ${action.size}@${price}`;
    }
    case 'cancel_order':
      await client.cancelOrder(action.orderId, agentId);
      return `cancel ${action.orderId}`;
    case 'split':
      await client.split(agentId, action.marketId, Number(action.amount));
      return `split ${action.amount}`;
    case 'merge':
      await client.merge(agentId, action.marketId, Number(action.amount));
      return `merge ${action.amount}`;
    case 'claim':
      // Claims settle automatically at market resolution; nothing to submit.
      return 'claim (auto-settled at resolution)';
    case 'update_position':
      return 'skip update_position (not yet supported by engine)';
    case 'hold':
      return `hold (${action.reason})`;
    default:
      return 'skip unknown action';
  }
}

export interface RunLiveOptions {
  client: IndexerClient;
  agentId: string;
  strategy: StrategyModule;
  turns: number;
}

export interface RunLiveResult {
  turn: number;
  applied: string[];
  errors: string[];
}

/**
 * Drive a strategy against the live indexer: fetch observation, decide, submit
 * the resulting actions. Per-action failures (e.g. insufficient collateral) are
 * collected, not fatal — agents trade with real, enforced constraints.
 */
export async function runLive(options: RunLiveOptions): Promise<RunLiveResult[]> {
  const { client, agentId, strategy, turns } = options;
  const results: RunLiveResult[] = [];

  for (let turn = 1; turn <= turns; turn += 1) {
    const observation = await client.observation(agentId, turn);
    const ordersById = new Map(observation.orders.map((order) => [order.orderId, order]));
    const output: AgentTurnOutput = await strategy.decide(observation);
    const validation = validateTurnOutput(output, observation);
    const effective = validation.output ?? output;

    const applied: string[] = [];
    const errors: string[] = [];
    for (const action of effective.tradeActions) {
      try {
        applied.push(await applyAction(client, agentId, action, ordersById));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    results.push({ turn, applied, errors });
  }

  return results;
}
