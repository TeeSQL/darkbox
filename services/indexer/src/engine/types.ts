export type Outcome = 'YES' | 'NO';
export type Side = 'buy' | 'sell';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type MarketStatus = 'open' | 'paused' | 'resolved' | 'voided';

export interface Order {
  orderId: string;
  agentId: string;
  marketId: string;
  outcome: Outcome;
  side: Side;
  price: number;
  size: number;
  remaining: number;
  timeInForce: TimeInForce;
  /** Monotonic sequence number for price-time priority. */
  seq: number;
}

export interface Fill {
  fillId: string;
  marketId: string;
  outcome: Outcome;
  price: number;
  size: number;
  makerOrderId: string;
  takerOrderId: string | null;
  makerAgentId: string;
  takerAgentId: string;
  /** The side the aggressor (taker) took. */
  takerSide: Side;
  seq: number;
}

/** Per-(agent, market, outcome) token holding. */
export interface Position {
  qty: number;
  /** Tokens locked by resting sell orders. */
  reserved: number;
  /** Average acquisition cost per token; used for realized/unrealized PnL. */
  avgCost: number;
}

export interface Balance {
  /** Total collateral ever deposited; the leaderboard starting balance. */
  deposited: number;
  /** Free collateral. */
  available: number;
  /** Collateral locked by resting buy orders. */
  reservedCollateral: number;
  /** Cumulative realized PnL across all markets. */
  realizedPnl: number;
}

export interface Market {
  marketId: string;
  question: string;
  status: MarketStatus;
  resolvedOutcome: Outcome | null;
  lastPrice: { YES: number | null; NO: number | null };
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
