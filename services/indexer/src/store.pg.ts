import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Identity } from '@darkbox/shared';
import {
  type IdentityInsert,
  type LeaderboardSnapshotInput,
  type Store,
  UniqueViolationError,
} from './store.js';

const { Pool } = pg;
const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sql');
const PG_UNIQUE_VIOLATION = '23505';

interface IdentityRow {
  shadow_account: string;
  daemon_name: string;
  source: string;
  agent_id: string | null;
  owner_address: string | null;
  telegram_user_id: string | null;
  telegram_handle: string | null;
  ens_name: string | null;
  created_at: Date;
}

function rowToIdentity(row: IdentityRow): Identity {
  return {
    shadowAccount: row.shadow_account,
    daemonName: row.daemon_name,
    source: row.source as Identity['source'],
    agentId: row.agent_id ?? undefined,
    ownerAddress: row.owner_address ?? undefined,
    telegramUserId: row.telegram_user_id ?? undefined,
    telegramHandle: row.telegram_handle ?? undefined,
    ensName: row.ens_name ?? undefined,
    createdAt: row.created_at.toISOString(),
  } as Identity;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const files = fs
      .readdirSync(SQL_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const filename of files) {
      const applied = await this.pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
      if (applied.rowCount && applied.rowCount > 0) continue;
      const sql = fs.readFileSync(path.join(SQL_DIR, filename), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async insertIdentity(input: IdentityInsert): Promise<Identity> {
    try {
      const result = await this.pool.query<IdentityRow>(
        `INSERT INTO identity
           (shadow_account, daemon_name, source, agent_id, owner_address, telegram_user_id, telegram_handle, ens_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.shadowAccount,
          input.daemonName,
          input.source,
          input.agentId ?? null,
          input.ownerAddress ?? null,
          input.telegramUserId ?? null,
          input.telegramHandle ?? null,
          input.ensName ?? null,
        ],
      );
      return rowToIdentity(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UniqueViolationError((error as { constraint?: string }).constraint ?? 'unknown');
      }
      throw error;
    }
  }

  private async getIdentityBy(column: string, value: string): Promise<Identity | null> {
    const result = await this.pool.query<IdentityRow>(`SELECT * FROM identity WHERE ${column} = $1`, [value]);
    return result.rows[0] ? rowToIdentity(result.rows[0]) : null;
  }

  getIdentityByShadowAccount(shadowAccount: string): Promise<Identity | null> {
    return this.getIdentityBy('shadow_account', shadowAccount);
  }

  getIdentityByTelegramUserId(telegramUserId: string): Promise<Identity | null> {
    return this.getIdentityBy('telegram_user_id', telegramUserId);
  }

  getIdentityByDaemonName(daemonName: string): Promise<Identity | null> {
    return this.getIdentityBy('daemon_name', daemonName);
  }

  async upsertLeaderboardSnapshot(input: LeaderboardSnapshotInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO leaderboard_snapshot (shadow_account, agent_id, starting_balance, current_equity, pnl, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (shadow_account) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         starting_balance = EXCLUDED.starting_balance,
         current_equity = EXCLUDED.current_equity,
         pnl = EXCLUDED.pnl,
         updated_at = now()`,
      [input.shadowAccount, input.agentId, input.startingBalance, input.currentEquity, input.pnl],
    );
  }

  async getLeaderboard() {
    const result = await this.pool.query(
      `SELECT s.agent_id, i.daemon_name, i.ens_name,
              s.starting_balance::text AS starting_balance,
              s.current_equity::text   AS current_equity,
              s.pnl::text              AS pnl,
              ROW_NUMBER() OVER (ORDER BY s.pnl DESC) AS rank
         FROM leaderboard_snapshot s
         JOIN identity i ON i.shadow_account = s.shadow_account
        ORDER BY s.pnl DESC`,
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      daemonName: row.daemon_name,
      ensName: row.ens_name ?? undefined,
      startingBalance: row.starting_balance,
      currentEquity: row.current_equity,
      pnl: row.pnl,
      rank: Number(row.rank),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
