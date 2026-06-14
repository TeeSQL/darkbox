import type { Identity, IdentitySource, LeaderboardEntry } from '@darkbox/shared';

/** Raised when a write violates a UNIQUE constraint (daemon_name, telegram_user_id). */
export class UniqueViolationError extends Error {
  constructor(public readonly constraintHint: string) {
    super(`unique violation: ${constraintHint}`);
    this.name = 'UniqueViolationError';
  }
}

/** Fields needed to persist a new identity. daemonName is decided by the repository. */
export interface IdentityInsert {
  shadowAccount: string;
  daemonName: string;
  source: IdentitySource;
  agentId?: string;
  ownerAddress?: string;
  telegramUserId?: string;
  telegramHandle?: string;
  ensName?: string;
}

/** A raw leaderboard datapoint produced by the indexer's PnL accounting. */
export interface LeaderboardSnapshotInput {
  agentId: string;
  shadowAccount: string;
  startingBalance: string;
  currentEquity: string;
  pnl: string;
}

/**
 * Persistence boundary for the indexer. Two implementations exist: a Postgres
 * store (production) and an in-memory store (local dev / tests). Daemon-name
 * collision handling lives above this layer in the identity repository; the
 * store's only obligation is to surface UniqueViolationError on conflict.
 */
export interface Store {
  migrate(): Promise<void>;
  insertIdentity(input: IdentityInsert): Promise<Identity>;
  getIdentityByShadowAccount(shadowAccount: string): Promise<Identity | null>;
  getIdentityByTelegramUserId(telegramUserId: string): Promise<Identity | null>;
  getIdentityByDaemonName(daemonName: string): Promise<Identity | null>;
  upsertLeaderboardSnapshot(input: LeaderboardSnapshotInput): Promise<void>;
  /** Returns leaderboard entries joined with identity, sorted by pnl desc, ranked. */
  getLeaderboard(): Promise<LeaderboardEntry[]>;
  close(): Promise<void>;
}
