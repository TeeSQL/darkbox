import type { FastifyInstance } from "fastify";
import { query } from "../db.js";

// ─── Public-safe field filters ────────────────────────────────────────────────
// These keys MUST NEVER appear in any /public/* response body.
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "shadow_account",
  "shadowAccount",
  "current_balance",
  "currentBalance",
  "total_deposited",
  "totalDeposited",
  "total_withdrawn",
  "totalWithdrawn",
  "total_credited",
  "totalCredited",
  "total_burned",
  "totalBurned",
  "orders",
  "fills",
  "positions",
  "orderbook",
  "raw_data",
  "rawData",
  "instruction_hash",
  "instructionHash",
  "runtime_hash",
  "runtimeHash",
  "reveal_salt_hash",
  "revealSaltHash",
  "tx_hash",
  "txHash",
  "log_index",
  "logIndex",
]);

export function stripForbidden(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripForbidden);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!FORBIDDEN_PUBLIC_KEYS.has(k)) {
        out[k] = stripForbidden(v);
      }
    }
    return out;
  }
  return obj;
}

export function hasForbiddenKey(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some(hasForbiddenKey);
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(k)) return true;
      if (hasForbiddenKey(v)) return true;
    }
  }
  return false;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get("/public/health", async () => {
    return { status: "ok", service: "darkbox-indexer", endpoint: "public" };
  });

  app.get("/public/game", async () => {
    const stats = await query<{ key: string; value: string }>(
      "SELECT key, value FROM aggregate_stats",
    );
    const counts: Record<string, string> = {};
    for (const row of stats.rows) {
      counts[row.key] = row.value;
    }
    return stripForbidden({
      active_markets: counts["active_markets"] ?? "0",
      active_agents: counts["active_agents"] ?? "0",
      total_trades: counts["total_trades"] ?? "0",
      total_volume_usdc: counts["total_volume_usdc"] ?? "0",
      positions_opened: counts["positions_opened"] ?? "0",
      positions_closed: counts["positions_closed"] ?? "0",
    });
  });

  app.get("/public/markets", async () => {
    const result = await query<{
      market_id: string;
      game_id: string;
      question: string;
      metadata_uri: string;
      close_time: string;
      resolve_by: string;
      resolver_type: string;
      status: string;
      resolved_outcome: string | null;
      created_at_ts: string;
    }>(
      `SELECT market_id, game_id, question, metadata_uri, close_time, resolve_by,
              resolver_type, status, resolved_outcome, created_at_ts
       FROM markets ORDER BY created_at_ts DESC`,
    );
    return stripForbidden(result.rows);
  });

  app.get<{ Params: { marketId: string } }>(
    "/public/markets/:marketId",
    async (req, reply) => {
      const result = await query<{
        market_id: string;
        game_id: string;
        question: string;
        metadata_uri: string;
        close_time: string;
        resolve_by: string;
        resolver_type: string;
        status: string;
        resolved_outcome: string | null;
        resolution_hash: string | null;
        created_at_ts: string;
      }>(
        `SELECT market_id, game_id, question, metadata_uri, close_time, resolve_by,
                resolver_type, status, resolved_outcome, resolution_hash, created_at_ts
         FROM markets WHERE market_id = $1`,
        [req.params.marketId.toLowerCase()],
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Market not found" });
      }
      return stripForbidden(result.rows[0]);
    },
  );

  app.get("/public/leaderboard", async () => {
    // Latest snapshot per shadow_account
    const result = await query<{
      agent_id: string;
      ens_name: string;
      rank: number;
      realized_pnl: string;
      pnl_pct: string;
      equity: string;
      net_deposits: string;
    }>(
      `SELECT DISTINCT ON (shadow_account)
         agent_id, ens_name, rank, realized_pnl, pnl_pct, equity, net_deposits
       FROM leaderboard_snapshots
       ORDER BY shadow_account, snapshot_time DESC`,
    );

    // Public leaderboard never exposes shadow_account or balances
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      ensName: row.ens_name,
      rank: row.rank,
      pnl: row.realized_pnl,
      pnlPct: row.pnl_pct,
      equity: row.equity,
      netDeposits: row.net_deposits,
    }));
  });

  app.get("/public/activity", async () => {
    const result = await query<{ key: string; value: string }>(
      "SELECT key, value FROM aggregate_stats",
    );
    const counts: Record<string, string> = {};
    for (const row of result.rows) {
      counts[row.key] = row.value;
    }
    return stripForbidden({
      total_deposits_count: counts["total_deposits_count"] ?? "0",
      total_withdrawals_count: counts["total_withdrawals_count"] ?? "0",
      total_trades: counts["total_trades"] ?? "0",
      total_volume_usdc: counts["total_volume_usdc"] ?? "0",
      active_markets: counts["active_markets"] ?? "0",
      active_agents: counts["active_agents"] ?? "0",
    });
  });

  app.get("/public/timeseries", async (req) => {
    const metric = (req.query as Record<string, string>)["metric"] ?? "total_trades";
    const limit = Math.min(Number((req.query as Record<string, string>)["limit"] ?? "100"), 1000);
    const result = await query<{
      recorded_at: string;
      metric: string;
      value: string;
    }>(
      `SELECT recorded_at, metric, value FROM activity_datapoints
       WHERE metric = $1
       ORDER BY recorded_at DESC LIMIT $2`,
      [metric, limit],
    );
    return result.rows;
  });

  // Alias for /public/timeseries
  app.get("/public/datapoints", async (req) => {
    const metric = (req.query as Record<string, string>)["metric"] ?? "total_trades";
    const limit = Math.min(Number((req.query as Record<string, string>)["limit"] ?? "100"), 1000);
    const result = await query<{
      recorded_at: string;
      metric: string;
      value: string;
    }>(
      `SELECT recorded_at, metric, value FROM activity_datapoints
       WHERE metric = $1
       ORDER BY recorded_at DESC LIMIT $2`,
      [metric, limit],
    );
    return result.rows;
  });

  app.get<{ Params: { agentId: string } }>(
    "/public/agents/:agentId/status",
    async (req, reply) => {
      const result = await query<{
        agent_id: string;
        ens_name: string;
        registered_at_ts: string;
      }>(
        `SELECT agent_id, ens_name, registered_at_ts
         FROM agents WHERE agent_id = $1`,
        [req.params.agentId.toLowerCase()],
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const a = result.rows[0]!;
      return {
        agentId: a.agent_id,
        ensName: a.ens_name,
        registeredAt: a.registered_at_ts,
      };
    },
  );

  app.get("/public/reveal/status", async () => {
    // Placeholder — reveal bundle status is managed by the reveal service
    return { revealed: false, revealScheduled: false };
  });
}
