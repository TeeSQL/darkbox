import { z } from 'zod';

const decimalString = z.string().regex(/^\d+(?:\.\d+)?$/, 'expected decimal string');
const isoDateString = z.string().datetime({ offset: true }).or(z.string().date());
const idString = z.string().min(1);

export const agentIdSchema = z.string().min(1);
export const marketIdSchema = z.string().min(1);
export const orderIdSchema = z.string().min(1);

export const outcomeSchema = z.enum(['YES', 'NO']);
export const sideSchema = z.enum(['buy', 'sell']);
export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);

export const makeOrderActionSchema = z.object({
  type: z.literal('make_order'),
  marketId: marketIdSchema,
  side: sideSchema,
  outcome: outcomeSchema,
  price: decimalString,
  size: decimalString,
  timeInForce: timeInForceSchema.default('GTC'),
});

export const takeOrderActionSchema = z.object({
  type: z.literal('take_order'),
  marketId: marketIdSchema,
  orderId: orderIdSchema,
  size: decimalString,
  maxPrice: decimalString.optional(),
  minPrice: decimalString.optional(),
});

export const cancelOrderActionSchema = z.object({
  type: z.literal('cancel_order'),
  orderId: orderIdSchema,
});

export const splitActionSchema = z.object({
  type: z.literal('split'),
  marketId: marketIdSchema,
  amount: decimalString,
});

export const mergeActionSchema = z.object({
  type: z.literal('merge'),
  marketId: marketIdSchema,
  amount: decimalString,
});

export const claimActionSchema = z.object({
  type: z.literal('claim'),
  marketId: marketIdSchema,
  outcome: outcomeSchema,
  amount: decimalString.optional(),
});

export const updatePositionActionSchema = z.object({
  type: z.literal('update_position'),
  marketId: marketIdSchema,
  intent: z.enum(['reduce', 'rebalance', 'close']),
  maxSlippageBps: z.number().int().min(0).max(10_000).default(100),
});

export const holdActionSchema = z.object({
  type: z.literal('hold'),
  reason: z.string().min(1).max(500),
});

export const tradeActionSchema = z.discriminatedUnion('type', [
  makeOrderActionSchema,
  takeOrderActionSchema,
  cancelOrderActionSchema,
  splitActionSchema,
  mergeActionSchema,
  claimActionSchema,
  updatePositionActionSchema,
  holdActionSchema,
]);

export const billboardPostSchema = z.object({
  message: z.string().min(1).max(280),
});

export const marketProposalSchema = z.object({
  question: z.string().min(8).max(200),
  description: z.string().min(1).max(2000),
  outcomes: z.tuple([z.literal('YES'), z.literal('NO')]),
  resolveBy: isoDateString,
  resolutionSource: z.string().min(1).max(500),
  rationale: z.string().min(1).max(1000),
});

export const agentTurnOutputSchema = z.object({
  tradeActions: z.array(tradeActionSchema).max(10).default([]),
  billboardPost: billboardPostSchema.nullable().default(null),
  marketProposal: marketProposalSchema.nullable().default(null),
  reason: z.string().max(2000).optional(),
});

export const marketSnapshotSchema = z.object({
  marketId: marketIdSchema,
  question: z.string(),
  status: z.enum(['open', 'paused', 'resolved', 'voided']).default('open'),
  bestBid: decimalString.nullable().default(null),
  bestAsk: decimalString.nullable().default(null),
  lastPrice: decimalString.nullable().default(null),
});

export const orderSnapshotSchema = z.object({
  orderId: orderIdSchema,
  marketId: marketIdSchema,
  agentId: agentIdSchema,
  side: sideSchema,
  outcome: outcomeSchema,
  price: decimalString,
  size: decimalString,
  remainingSize: decimalString,
});

export const balanceSnapshotSchema = z.object({
  agentId: agentIdSchema,
  available: decimalString,
  equity: decimalString,
});

export const billboardMessageSchema = z.object({
  messageId: idString,
  agentId: agentIdSchema,
  message: z.string().min(1).max(280),
  createdAt: z.string().datetime({ offset: true }),
});

export const marketProposalSnapshotSchema = z.object({
  proposalId: idString,
  agentId: agentIdSchema,
  question: z.string(),
  status: z.enum(['proposed', 'approved', 'deployed', 'rejected', 'expired']),
});

export const agentObservationSchema = z.object({
  agentId: agentIdSchema,
  turn: z.number().int().min(0),
  now: z.string().datetime({ offset: true }),
  markets: z.array(marketSnapshotSchema),
  orders: z.array(orderSnapshotSchema).default([]),
  balances: z.array(balanceSnapshotSchema).default([]),
  billboardSinceLastTurn: z.array(billboardMessageSchema).default([]),
  marketProposals: z.array(marketProposalSnapshotSchema).default([]),
  sharedContext: z.array(z.string()).default([]),
});

export type TradeAction = z.infer<typeof tradeActionSchema>;
export type BillboardPost = z.infer<typeof billboardPostSchema>;
export type MarketProposal = z.infer<typeof marketProposalSchema>;
export type AgentTurnOutput = z.infer<typeof agentTurnOutputSchema>;
export type AgentObservation = z.infer<typeof agentObservationSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type OrderSnapshot = z.infer<typeof orderSnapshotSchema>;

export function parseAgentTurnOutput(input: unknown): AgentTurnOutput {
  return agentTurnOutputSchema.parse(input);
}

export function parseAgentObservation(input: unknown): AgentObservation {
  return agentObservationSchema.parse(input);
}
