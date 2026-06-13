import { query, withTransaction } from "../db.js";

/**
 * Take a leaderboard + PnL snapshot. Runs on a timer (snapshotIntervalMs).
 * This materializes the current state for time-series queries.
 */
export async function takeSnapshot(): Promise<void> {
  await withTransaction(async (client) => {
    // 1. Compute per-agent equity from balances
    const agentsResult = await client.query<{
      shadow_account: string;
      agent_id: string;
      ens_name: string;
      total_deposited: string;
      total_withdrawn: string;
      current_balance: string;
    }>(
      `SELECT
         b.shadow_account,
         a.agent_id,
         COALESCE(a.ens_name, '') as ens_name,
         COALESCE(SUM(b.total_deposited::numeric), 0)::text as total_deposited,
         COALESCE(SUM(b.total_withdrawn::numeric), 0)::text as total_withdrawn,
         COALESCE(SUM(b.current_balance::numeric), 0)::text as current_balance
       FROM balances b
       LEFT JOIN agents a ON a.shadow_account = b.shadow_account
       GROUP BY b.shadow_account, a.agent_id, a.ens_name`,
    );

    // 2. Compute realized PnL per shadow account
    const pnlResult = await client.query<{
      shadow_account: string;
      realized_pnl: string;
    }>(
      `SELECT shadow_account, COALESCE(SUM(realized_pnl::numeric), 0)::text as realized_pnl
       FROM positions
       GROUP BY shadow_account`,
    );
    const pnlMap = new Map<string, string>();
    for (const row of pnlResult.rows) {
      pnlMap.set(row.shadow_account, row.realized_pnl);
    }

    // 3. Rank by equity
    const entries = agentsResult.rows
      .map((row) => {
        const netDeposits = (
          BigInt(row.total_deposited || "0") - BigInt(row.total_withdrawn || "0")
        ).toString();
        const realizedPnl = pnlMap.get(row.shadow_account) ?? "0";
        const equity = row.current_balance;
        const pnlPct =
          netDeposits !== "0"
            ? ((Number(realizedPnl) / Number(netDeposits)) * 100).toFixed(4)
            : "0";
        return {
          shadow_account: row.shadow_account,
          agent_id: row.agent_id,
          ens_name: row.ens_name,
          net_deposits: netDeposits,
          realized_pnl: realizedPnl,
          equity,
          pnl_pct: pnlPct,
        };
      })
      .sort((a, b) => Number(b.equity) - Number(a.equity));

    // 4. Insert leaderboard snapshot
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const rank = i + 1;
      await client.query(
        `INSERT INTO leaderboard_snapshots
           (shadow_account, agent_id, ens_name, rank, net_deposits, realized_pnl, equity, pnl_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          e.shadow_account,
          e.agent_id,
          e.ens_name,
          rank,
          e.net_deposits,
          e.realized_pnl,
          e.equity,
          e.pnl_pct,
        ],
      );

      await client.query(
        `INSERT INTO pnl_snapshots
           (shadow_account, total_deposited, total_withdrawn, net_deposits,
            realized_pnl, current_balance, equity, rank)
         SELECT
           $1,
           COALESCE(SUM(total_deposited::numeric), 0)::text,
           COALESCE(SUM(total_withdrawn::numeric), 0)::text,
           $2,
           $3,
           COALESCE(SUM(current_balance::numeric), 0)::text,
           $4,
           $5
         FROM balances WHERE shadow_account = $1`,
        [e.shadow_account, e.net_deposits, e.realized_pnl, e.equity, rank],
      );
    }

    // 5. Emit activity datapoints
    const stats = await client.query<{ key: string; value: string }>(
      "SELECT key, value FROM aggregate_stats",
    );
    for (const row of stats.rows) {
      await client.query(
        "INSERT INTO activity_datapoints (metric, value) VALUES ($1, $2)",
        [row.key, row.value],
      );
    }
  });
}
