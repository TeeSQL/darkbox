import { z } from 'zod';

const hexSha256Schema = z.string().regex(/^0x[a-f0-9]{64}$/, 'expected 0x-prefixed sha256 digest');
const isoDateString = z.string().datetime({ offset: true });
const idString = z.string().min(1);

export const agentTurnLogSchema = z.object({
  version: z.literal(1),
  gameId: idString.default('darkbox-demo-game'),
  agentId: idString,
  turn: z.number().int().min(0),
  recordedAt: isoDateString,
  strategy: z.string().min(1),
  provider: z.string().min(1).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  observationHash: hexSha256Schema,
  policyHash: hexSha256Schema,
  rawOutputHash: hexSha256Schema,
  validatedOutputHash: hexSha256Schema.nullable().default(null),
  validation: z.object({
    ok: z.boolean(),
    errors: z.array(z.string()).default([]),
  }),
  actionSummary: z.object({
    tradeActionCount: z.number().int().nonnegative(),
    tradeActionTypes: z.array(z.string()).default([]),
    hasBillboardPost: z.boolean(),
    hasMarketProposal: z.boolean(),
  }),
  submittedRefs: z.array(z.object({
    kind: z.enum(['tx', 'order', 'fill', 'proposal', 'billboard', 'other']),
    id: idString,
    hash: hexSha256Schema.nullable().default(null),
  })).default([]),
});

export const agentTurnLogBatchSchema = z.object({
  logs: z.array(agentTurnLogSchema).min(1),
});

export type AgentTurnLog = z.infer<typeof agentTurnLogSchema>;
export type AgentTurnLogBatch = z.infer<typeof agentTurnLogBatchSchema>;
