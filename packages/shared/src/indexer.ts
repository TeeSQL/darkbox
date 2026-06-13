import { z } from 'zod';

const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/, 'expected decimal string');
const nonNegativeDecimalString = z.string().regex(/^\d+(?:\.\d+)?$/, 'expected non-negative decimal string');
const idString = z.string().min(1);
const isoDateString = z.string().datetime({ offset: true });

export const marketStatusSchema = z.enum(['draft', 'open', 'paused', 'closed', 'resolved', 'voided']);
export const indexerOutcomeSchema = z.enum(['YES', 'NO']);
export const indexerOrderSideSchema = z.enum(['buy', 'sell']);

export const publicGameSchema = z.object({
  gameId: idString,
  title: z.string().min(1),
  status: z.enum(['pending', 'live', 'frozen', 'revealing', 'settled']),
  startsAt: isoDateString,
  endsAt: isoDateString,
  revealStatus: z.enum(['not_started', 'building', 'published']),
  updatedAt: isoDateString,
});

export const marketResolverTypeSchema = z.enum([
  'AdminManual',
  'EthGlobalProjectCount',
  'EthGlobalSponsorComboCount',
  'EthGlobalSoloHackerCount',
  'EthGlobalFinalistManual',
  'DaemonhallMetricThreshold',
  'DependentMarket',
  'VoidOnly',
]);

export const marketResolutionDossierSchema = z.object({
  dossierId: idString,
  marketId: idString,
  resolverType: marketResolverTypeSchema,
  outcome: z.enum(['YES', 'NO', 'INVALID']),
  decidedAt: isoDateString,
  source: z.string().min(1),
  rule: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()),
  confidence: z.enum(['low', 'medium', 'high']),
  notes: z.array(z.string()).default([]),
});

export const marketResolverConfigSchema = z.object({
  resolverType: marketResolverTypeSchema,
  source: z.enum(['ethglobal', 'daemonhall', 'manual', 'dependent']),
  event: z.string().optional(),
  metric: z.string().optional(),
  sponsorTerms: z.array(z.string()).optional(),
  matchMode: z.enum(['any', 'all']).optional(),
  operator: z.enum(['>=', '>', '<=', '<', '==']).optional(),
  threshold: z.number().optional(),
  finalAt: isoDateString.optional(),
  earlyYes: z.boolean().optional(),
  earlyNo: z.boolean().optional(),
  fallback: z.enum(['manual', 'invalid']).optional(),
}).passthrough();

export const publicMarketSchema = z.object({
  marketId: idString,
  question: z.string().min(1),
  description: z.string().nullable().default(null),
  status: marketStatusSchema,
  outcomes: z.tuple([z.literal('YES'), z.literal('NO')]),
  resolver: z.string().nullable().default(null),
  resolverType: marketResolverTypeSchema.nullable().default(null),
  resolverConfig: marketResolverConfigSchema.nullable().default(null),
  resolutionDossier: marketResolutionDossierSchema.nullable().default(null),
  closesAt: isoDateString.nullable().default(null),
  createdAt: isoDateString,
  updatedAt: isoDateString,
});

export const publicLeaderboardEntrySchema = z.object({
  agentId: idString,
  displayName: z.string().min(1),
  ensName: z.string().nullable().default(null),
  rank: z.number().int().positive(),
  pnl: decimalString,
  drawdown: decimalString.nullable().default(null),
  updatedAt: isoDateString,
});

export const publicActivitySchema = z.object({
  totalDeposits: nonNegativeDecimalString,
  totalTrades: z.number().int().nonnegative(),
  totalVolume: nonNegativeDecimalString,
  positionsOpened: z.number().int().nonnegative(),
  positionsClosed: z.number().int().nonnegative(),
  activeMarkets: z.number().int().nonnegative(),
  activeAgents: z.number().int().nonnegative(),
  updatedAt: isoDateString,
});

export const internalAgentStateSchema = z.object({
  agentId: idString,
  displayName: z.string().min(1),
  ensName: z.string().nullable().default(null),
  availableBalance: nonNegativeDecimalString,
  equity: nonNegativeDecimalString,
  pnl: decimalString,
  positions: z.array(z.object({
    marketId: idString,
    outcome: indexerOutcomeSchema,
    size: decimalString,
    averagePrice: nonNegativeDecimalString,
    realizedPnl: decimalString,
    unrealizedPnl: decimalString,
  })),
  updatedAt: isoDateString,
});

export const internalOrderSchema = z.object({
  orderId: idString,
  marketId: idString,
  agentId: idString,
  side: indexerOrderSideSchema,
  outcome: indexerOutcomeSchema,
  price: nonNegativeDecimalString,
  size: nonNegativeDecimalString,
  remainingSize: nonNegativeDecimalString,
  status: z.enum(['open', 'partially_filled', 'filled', 'cancelled']),
  createdAt: isoDateString,
  updatedAt: isoDateString,
});

export const internalFillSchema = z.object({
  fillId: idString,
  marketId: idString,
  makerAgentId: idString,
  takerAgentId: idString,
  outcome: indexerOutcomeSchema,
  price: nonNegativeDecimalString,
  size: nonNegativeDecimalString,
  txHash: idString,
  blockNumber: z.number().int().nonnegative(),
  createdAt: isoDateString,
});

export type PublicGame = z.infer<typeof publicGameSchema>;
export type MarketResolverType = z.infer<typeof marketResolverTypeSchema>;
export type MarketResolverConfig = z.infer<typeof marketResolverConfigSchema>;
export type MarketResolutionDossier = z.infer<typeof marketResolutionDossierSchema>;
export type PublicMarket = z.infer<typeof publicMarketSchema>;
export type PublicLeaderboardEntry = z.infer<typeof publicLeaderboardEntrySchema>;
export type PublicActivity = z.infer<typeof publicActivitySchema>;
export type InternalAgentState = z.infer<typeof internalAgentStateSchema>;
export type InternalOrder = z.infer<typeof internalOrderSchema>;
export type InternalFill = z.infer<typeof internalFillSchema>;
