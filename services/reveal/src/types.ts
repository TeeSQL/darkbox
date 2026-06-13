/**
 * Reveal bundle types.
 *
 * The reveal bundle is the "box opens" artifact: everything needed to AUDIT and
 * REPLAY a finished game. The indexer owns the derived state; this service
 * composes it with on-chain deploy metadata into one signed, reconciled bundle.
 */
import type { Hex } from "viem";

/** A market's revealed state. */
export interface MarketReveal {
  marketId: string;
  question: string;
  status: string;
  resolverType?: string;
  outcome?: string | null;
  closesAt?: string | null;
}

export interface OrderRecord {
  marketId: string;
  agentId: string;
  side: string;
  price: string;
  size: string;
  t?: number;
}
export interface FillRecord {
  marketId: string;
  makerAgentId?: string;
  takerAgentId?: string;
  price: string;
  size: string;
  fee?: string;
  t?: number;
}
export interface PositionRecord {
  marketId: string;
  agentId: string;
  outcome: string;
  size: string;
}

export interface LeaderboardRow {
  agentId: string;
  ensName?: string;
  pnl: string;
  rank: number;
}

export interface AgentReveal {
  agentId: string;
  ensName?: string;
  instructionHash?: Hex;
  runtimeHash?: Hex;
  revealSaltHash?: Hex;
  /** Strategy preimage — included ONLY when reveal policy allows. */
  revealedInstruction?: string;
  turnLogHashes?: Hex[];
}

/** Accounting needed to audit public USDC vs hidden shadow balances. */
export interface AccountingRecord {
  publicDepositedUsdc: string;
  shadowMintedUsdc: string;
  promoCreditedUsdc: string;
  withdrawnUsdc: string;
  feesAccruedUsdc: string;
  /** publicDeposited + promoCredited should equal shadowMinted (mint backing). */
  reconciled: boolean;
  discrepancyUsdc: string;
}

/** Replay timeline event (marketing 05 schema). */
export interface RevealEvent {
  t: number;
  type: string;
  [k: string]: unknown;
}

export interface RevealMeta {
  gameId: string;
  title: string;
  builtAt: string; // ISO; stamped by the caller (not inside the pure builder)
  revealPolicy: { includeInstructions: boolean };
}

export interface RevealBundle {
  meta: RevealMeta;
  deployments: Record<string, unknown>;
  markets: MarketReveal[];
  orders: OrderRecord[];
  fills: FillRecord[];
  positions: PositionRecord[];
  leaderboard: LeaderboardRow[];
  agents: AgentReveal[];
  accounting: AccountingRecord;
  timeline: RevealEvent[];
  integrity: { bundleHash: Hex; eventCount: number };
}

/** Everything the builder needs, injectable so it's testable without a live indexer. */
export interface RevealSources {
  getDeployments(): Promise<Record<string, unknown>>;
  getMarkets(): Promise<MarketReveal[]>;
  getOrders(): Promise<OrderRecord[]>;
  getFills(): Promise<FillRecord[]>;
  getPositions(): Promise<PositionRecord[]>;
  getLeaderboard(): Promise<LeaderboardRow[]>;
  getAgents(): Promise<AgentReveal[]>;
  getRawEvents(): Promise<RevealEvent[]>;
  getAccounting(): Promise<Omit<AccountingRecord, "reconciled" | "discrepancyUsdc">>;
}
