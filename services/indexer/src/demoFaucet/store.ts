/**
 * Postgres-backed DemoFaucetStore (table: demo_faucet_grants, migration 009).
 *
 * The two unique indexes (address, partial tg_id) are the persistent guardrail:
 * a duplicate `reserveGrant` raises SQLSTATE 23505, which we translate to `null`
 * so the caller skips the mint and replays the winner — minting at-most-once.
 */
import { query } from "../db.js";
import type { DemoFaucetGrant, DemoFaucetStore } from "./faucet.js";

interface GrantRow {
  id: string; // bigint comes back as string from pg
  address: string;
  tg_id: string | null;
  tx_hash: string | null;
  amount: string;
  status: string;
}

function toGrant(row: GrantRow): DemoFaucetGrant {
  return {
    id: parseInt(row.id, 10),
    address: row.address,
    tgId: row.tg_id,
    txHash: row.tx_hash,
    amount: row.amount,
    status: row.status === "granted" ? "granted" : "pending",
  };
}

const SELECT_COLS = "id, address, tg_id, tx_hash, amount, status";

export function createDbStore(): DemoFaucetStore {
  return {
    async findGrant(address: string, tgId: string | null): Promise<DemoFaucetGrant | null> {
      const result = await query<GrantRow>(
        `SELECT ${SELECT_COLS}
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

    async reserveGrant(reservation): Promise<DemoFaucetGrant | null> {
      try {
        const result = await query<GrantRow>(
          `INSERT INTO demo_faucet_grants (address, tg_id, amount, label, status)
           VALUES ($1, $2, $3, 'demo credit', 'pending')
           RETURNING ${SELECT_COLS}`,
          [reservation.address, reservation.tgId, reservation.amount],
        );
        const row = result.rows[0];
        return row ? toGrant(row) : null;
      } catch (err) {
        // 23505 = unique_violation → a concurrent claim already holds the slot.
        if ((err as { code?: string }).code === "23505") return null;
        throw err;
      }
    },

    async finalizeGrant(id: number, txHash: string): Promise<DemoFaucetGrant> {
      const result = await query<GrantRow>(
        `UPDATE demo_faucet_grants
            SET tx_hash = $2, status = 'granted'
          WHERE id = $1
          RETURNING ${SELECT_COLS}`,
        [id, txHash],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`demo_faucet_grants reservation ${id} vanished before finalize`);
      return toGrant(row);
    },

    async releaseGrant(id: number): Promise<void> {
      // Only drop a still-pending reservation; never remove a granted record.
      await query("DELETE FROM demo_faucet_grants WHERE id = $1 AND status = 'pending'", [id]);
    },
  };
}
