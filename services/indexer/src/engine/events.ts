import type { Outcome } from './types.js';
import type { PlaceOrderInput } from './engine.js';

/**
 * The append-only log of engine mutations. The engine is deterministic, so
 * replaying these events in order rebuilds exact balances, positions, orders
 * and PnL after a restart. Every mutating path on IndexerService records one
 * of these before applying it.
 */
export type EngineEvent =
  | { type: 'createMarket'; marketId: string; question: string }
  | { type: 'deposit'; agentId: string; amount: number; opId?: string }
  | { type: 'withdraw'; agentId: string; amount: number; commandId?: string }
  | { type: 'split'; agentId: string; marketId: string; amount: number }
  | { type: 'merge'; agentId: string; marketId: string; amount: number }
  | { type: 'placeOrder'; input: PlaceOrderInput }
  | { type: 'cancelOrder'; orderId: string; agentId: string }
  | { type: 'resolveMarket'; marketId: string; winningOutcome: Outcome }
  | { type: 'postBillboard'; messageId: string; agentId: string; message: string; createdAt: string }
  | {
      type: 'proposeMarket';
      proposalId: string;
      agentId: string;
      question: string;
      description: string;
      createdAt: string;
    }
  | { type: 'approveProposal'; proposalId: string; marketId: string };
