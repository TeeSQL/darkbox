import type { Identity, LeaderboardEntry } from '@darkbox/shared';
import {
  type IdentityInsert,
  type LeaderboardSnapshotInput,
  type Store,
  UniqueViolationError,
} from './store.js';

/**
 * In-memory store for local dev and tests. Mirrors the Postgres uniqueness
 * guarantees (shadow_account PK, daemon_name UNIQUE, telegram_user_id UNIQUE
 * where present) so the identity repository behaves identically against both.
 */
export class MemoryStore implements Store {
  private readonly identities = new Map<string, Identity>();
  private readonly snapshots = new Map<string, LeaderboardSnapshotInput>();

  async migrate(): Promise<void> {
    // No-op: schema is implicit for the in-memory store.
  }

  async insertIdentity(input: IdentityInsert): Promise<Identity> {
    if (this.identities.has(input.shadowAccount)) {
      throw new UniqueViolationError('identity_pkey');
    }
    for (const existing of this.identities.values()) {
      if (existing.daemonName === input.daemonName) {
        throw new UniqueViolationError('identity_daemon_name_key');
      }
      if (input.telegramUserId && existing.telegramUserId === input.telegramUserId) {
        throw new UniqueViolationError('identity_telegram_user_id_key');
      }
    }
    const identity: Identity = {
      shadowAccount: input.shadowAccount,
      daemonName: input.daemonName,
      source: input.source,
      agentId: input.agentId as Identity['agentId'],
      ownerAddress: input.ownerAddress,
      telegramUserId: input.telegramUserId,
      telegramHandle: input.telegramHandle,
      ensName: input.ensName,
      createdAt: new Date().toISOString(),
    };
    this.identities.set(identity.shadowAccount, identity);
    return identity;
  }

  async getIdentityByShadowAccount(shadowAccount: string): Promise<Identity | null> {
    return this.identities.get(shadowAccount) ?? null;
  }

  async getIdentityByTelegramUserId(telegramUserId: string): Promise<Identity | null> {
    for (const identity of this.identities.values()) {
      if (identity.telegramUserId === telegramUserId) return identity;
    }
    return null;
  }

  async getIdentityByDaemonName(daemonName: string): Promise<Identity | null> {
    for (const identity of this.identities.values()) {
      if (identity.daemonName === daemonName) return identity;
    }
    return null;
  }

  async getIdentityByAgentId(agentId: string): Promise<Identity | null> {
    for (const identity of this.identities.values()) {
      if (identity.agentId === agentId) return identity;
    }
    return null;
  }

  async upsertLeaderboardSnapshot(input: LeaderboardSnapshotInput): Promise<void> {
    this.snapshots.set(input.shadowAccount, input);
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    return [...this.snapshots.values()]
      .map((snapshot) => {
        const identity = this.identities.get(snapshot.shadowAccount);
        return { snapshot, identity };
      })
      .filter((row): row is { snapshot: LeaderboardSnapshotInput; identity: Identity } => Boolean(row.identity))
      .sort((a, b) => Number(b.snapshot.pnl) - Number(a.snapshot.pnl))
      .map(({ snapshot, identity }, index) => ({
        agentId: snapshot.agentId as LeaderboardEntry['agentId'],
        daemonName: identity.daemonName,
        ensName: identity.ensName,
        startingBalance: snapshot.startingBalance,
        currentEquity: snapshot.currentEquity,
        pnl: snapshot.pnl,
        rank: index + 1,
      }));
  }

  async close(): Promise<void> {
    this.identities.clear();
    this.snapshots.clear();
  }
}
