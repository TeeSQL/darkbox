import { withTransaction } from "../db.js";

/**
 * Take a leaderboard + PnL snapshot. Runs on a timer (snapshotIntervalMs).
 * This materializes the current state for time-series queries.
 */
export async function takeSnapshot(): Promise<void> {
  await withTransaction(takeSnapshotWithClient);
}

export async function takeSnapshotWithClient(
  client: { query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> },
): Promise<void> {
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

    // 2. Mark positions against latest traded market price, then compute PnL.
    // Prices are stored in micro-USDC per outcome token. If a market has never
    // traded, the position's market value remains zero rather than inventing a mark.
    await client.query(
      `UPDATE positions p SET
         market_value = CASE
           WHEN p.outcome = 'Yes' AND m.latest_yes_price IS NOT NULL
             THEN ((p.quantity::numeric * m.latest_yes_price::numeric) / 1000000)::text
           WHEN p.outcome = 'No' AND m.latest_no_price IS NOT NULL
             THEN ((p.quantity::numeric * m.latest_no_price::numeric) / 1000000)::text
           ELSE '0'
         END,
         unrealized_pnl = CASE
           WHEN p.outcome = 'Yes' AND m.latest_yes_price IS NOT NULL
             THEN (((p.quantity::numeric * m.latest_yes_price::numeric) / 1000000) - p.cost_basis::numeric)::text
           WHEN p.outcome = 'No' AND m.latest_no_price IS NOT NULL
             THEN (((p.quantity::numeric * m.latest_no_price::numeric) / 1000000) - p.cost_basis::numeric)::text
           ELSE '0'
         END,
         updated_at = NOW()
       FROM markets m
       WHERE p.market_id = m.market_id`,
    );

    const pnlResult = await client.query<{
      shadow_account: string;
      realized_pnl: string;
      unrealized_pnl: string;
      market_value: string;
    }>(
      `SELECT shadow_account,
              COALESCE(SUM(realized_pnl::numeric), 0)::text as realized_pnl,
              COALESCE(SUM(unrealized_pnl::numeric), 0)::text as unrealized_pnl,
              COALESCE(SUM(market_value::numeric), 0)::text as market_value
       FROM positions
       GROUP BY shadow_account`,
    );
    const pnlMap = new Map<string, { realized: string; unrealized: string; marketValue: string }>();
    for (const row of pnlResult.rows) {
      pnlMap.set(row.shadow_account, {
        realized: row.realized_pnl,
        unrealized: row.unrealized_pnl,
        marketValue: row.market_value,
      });
    }

    // 3. Rank by marked equity
    const entries = agentsResult.rows
      .map((row) => {
        const netDeposits = (
          BigInt(row.total_deposited || "0") - BigInt(row.total_withdrawn || "0")
        ).toString();
        const pnl = pnlMap.get(row.shadow_account) ?? { realized: "0", unrealized: "0", marketValue: "0" };
        const realizedPnl = pnl.realized;
        const unrealizedPnl = pnl.unrealized;
        const totalPnl = (BigInt(realizedPnl || "0") + BigInt(unrealizedPnl || "0")).toString();
        const equity = (BigInt(row.current_balance || "0") + BigInt(pnl.marketValue || "0")).toString();
        const pnlPct =
          netDeposits !== "0"
            ? ((Number(totalPnl) / Number(netDeposits)) * 100).toFixed(4)
            : "0";
        return {
          shadow_account: row.shadow_account,
          agent_id: row.agent_id,
          ens_name: row.ens_name,
          net_deposits: netDeposits,
          realized_pnl: realizedPnl,
          unrealized_pnl: unrealizedPnl,
          total_pnl: totalPnl,
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
           (shadow_account, agent_id, ens_name, rank, net_deposits, realized_pnl, unrealized_pnl, total_pnl, equity, pnl_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          e.shadow_account,
          e.agent_id,
          e.ens_name,
          rank,
          e.net_deposits,
          e.realized_pnl,
          e.unrealized_pnl,
          e.total_pnl,
          e.equity,
          e.pnl_pct,
        ],
      );

      await client.query(
        `INSERT INTO pnl_snapshots
           (shadow_account, total_deposited, total_withdrawn, net_deposits,
            realized_pnl, unrealized_pnl, total_pnl, current_balance, equity, rank)
         SELECT
           $1,
           COALESCE(SUM(total_deposited::numeric), 0)::text,
           COALESCE(SUM(total_withdrawn::numeric), 0)::text,
           $2,
           $3,
           $4,
           $5,
           COALESCE(SUM(current_balance::numeric), 0)::text,
           $6,
           $7
         FROM balances WHERE shadow_account = $1`,
        [e.shadow_account, e.net_deposits, e.realized_pnl, e.unrealized_pnl, e.total_pnl, e.equity, rank],
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
}
