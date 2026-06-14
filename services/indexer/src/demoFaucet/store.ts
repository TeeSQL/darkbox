/**
 * Postgres-backed DemoFaucetStore (table: demo_faucet_grants, migration 009).
 *
 * The two unique indexes (address, partial tg_id) are the persistent guardrail:
 * a duplicate insert raises SQLSTATE 23505, which we translate to `null` so the
 * caller replays the existing grant instead of minting twice.
 */
import { query } from "../db.js";
import type { DemoFaucetGrant, DemoFaucetStore } from "./faucet.js";

interface GrantRow {
  address: string;
  tg_id: string | null;
  tx_hash: string;
  amount: string;
}

function toGrant(row: GrantRow): DemoFaucetGrant {
  return { address: row.address, tgId: row.tg_id, txHash: row.tx_hash, amount: row.amount };
}

export function createDbStore(): DemoFaucetStore {
  return {
    async findGrant(address: string, tgId: string | null): Promise<DemoFaucetGrant | null> {
      const result = await query<GrantRow>(
        `SELECT address, tg_id, tx_hash, amount
           FROM demo_faucet_grants
          WHERE address = $1
             OR ($2::text IS NOT NULL AND tg_id = $2)
          ORDER BY created_at ASC
          LIMIT 1`,
        [address, tgId],
      );
      const row = result.rows[0];
      return row ? toGrant(row) : null;
    },

    async countGrants(): Promise<number> {
      const result = await query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM demo_faucet_grants",
      );
      return parseInt(result.rows[0]?.n ?? "0", 10);
    },

    async insertGrant(grant: DemoFaucetGrant): Promise<DemoFaucetGrant | null> {
      try {
        const result = await query<GrantRow>(
          `INSERT INTO demo_faucet_grants (address, tg_id, tx_hash, amount, label, status)
           VALUES ($1, $2, $3, $4, 'demo credit', 'granted')
           RETURNING address, tg_id, tx_hash, amount`,
          [grant.address, grant.tgId, grant.txHash, grant.amount],
        );
        const row = result.rows[0];
        return row ? toGrant(row) : null;
      } catch (err) {
        // 23505 = unique_violation → a concurrent claim already recorded a grant.
        if ((err as { code?: string }).code === "23505") return null;
        throw err;
      }
    },
  };
}
