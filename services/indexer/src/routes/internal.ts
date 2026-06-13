import type { FastifyInstance } from "fastify";
import { query } from "../db.js";

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/health", async () => {
    return {
      status: "ok",
      service: "darkbox-indexer",
      endpoint: "internal",
    };
  });

  app.get("/internal/cursors", async () => {
    const result = await query<{
      adapter: string;
      chain_id: number;
      contract_address: string;
      last_block: string;
      updated_at: string;
    }>("SELECT * FROM cursors ORDER BY adapter, chain_id, contract_address");
    return result.rows;
  });

  app.get("/internal/raw-events", async (req) => {
    const adapter = (req.query as Record<string, string>)["adapter"];
    const limit = Math.min(Number((req.query as Record<string, string>)["limit"] ?? "50"), 500);
    const offset = Number((req.query as Record<string, string>)["offset"] ?? "0");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (adapter) {
      params.push(adapter);
      conditions.push(`adapter = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const result = await query(
      `SELECT * FROM raw_events ${where}
       ORDER BY block_number DESC, log_index DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows;
  });

  // ─── Markets ─────────────────────────────────────────────────────────────

  app.get("/internal/markets", async () => {
    const result = await query("SELECT * FROM markets ORDER BY created_at_ts DESC");
    return result.rows;
  });

  app.get<{ Params: { marketId: string } }>(
    "/internal/markets/:marketId",
    async (req, reply) => {
      const result = await query(
        "SELECT * FROM markets WHERE market_id = $1",
        [req.params.marketId.toLowerCase()],
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Market not found" });
      }
      return result.rows[0];
    },
  );

  app.get<{ Params: { marketId: string } }>(
    "/internal/markets/:marketId/orderbook",
    async (req, reply) => {
      const marketId = req.params.marketId.toLowerCase();

      const marketResult = await query<{ yes_book: string; no_book: string }>(
        "SELECT yes_book, no_book FROM markets WHERE market_id = $1",
        [marketId],
      );
      if (marketResult.rows.length === 0) {
        return reply.status(404).send({ error: "Market not found" });
      }

      const { yes_book, no_book } = marketResult.rows[0]!;
      const books = [yes_book, no_book].filter(Boolean);

      const ordersResult = await query(
        `SELECT * FROM orders
         WHERE market_id = $1 AND status = 'open'
         ORDER BY side, lower_tick`,
        [marketId],
      );

      return {
        marketId,
        yesBook: yes_book,
        noBook: no_book,
        openOrders: ordersResult.rows,
      };
    },
  );

  // ─── Agents ───────────────────────────────────────────────────────────────

  app.get("/internal/agents", async () => {
    const result = await query(
      `SELECT a.*, b.current_balance, b.total_deposited, b.total_withdrawn, b.asset
       FROM agents a
       LEFT JOIN balances b ON b.shadow_account = a.shadow_account
       ORDER BY a.registered_at_ts DESC`,
    );
    return result.rows;
  });

  app.get<{ Params: { agentId: string } }>(
    "/internal/agents/:agentId/state",
    async (req, reply) => {
      const agentResult = await query(
        "SELECT * FROM agents WHERE agent_id = $1",
        [req.params.agentId.toLowerCase()],
      );
      if (agentResult.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const agent = agentResult.rows[0]!;

      const balancesResult = await query(
        "SELECT * FROM balances WHERE shadow_account = $1",
        [(agent as Record<string, unknown>)["shadow_account"]],
      );

      const positionsResult = await query(
        "SELECT * FROM positions WHERE shadow_account = $1",
        [(agent as Record<string, unknown>)["shadow_account"]],
      );

      const pnlResult = await query<{ realized_pnl: string }>(
        `SELECT COALESCE(SUM(realized_pnl::numeric), 0)::text as realized_pnl
         FROM positions WHERE shadow_account = $1`,
        [(agent as Record<string, unknown>)["shadow_account"]],
      );

      return {
        agent,
        balances: balancesResult.rows,
        positions: positionsResult.rows,
        realizedPnl: pnlResult.rows[0]?.realized_pnl ?? "0",
      };
    },
  );

  app.get<{ Params: { agentId: string } }>(
    "/internal/agents/:agentId/orders",
    async (req, reply) => {
      const agentResult = await query<{ shadow_account: string }>(
        "SELECT shadow_account FROM agents WHERE agent_id = $1",
        [req.params.agentId.toLowerCase()],
      );
      if (agentResult.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const { shadow_account } = agentResult.rows[0]!;
      const result = await query(
        "SELECT * FROM orders WHERE shadow_account = $1 ORDER BY placed_at_block DESC",
        [shadow_account],
      );
      return result.rows;
    },
  );

  app.get<{ Params: { agentId: string } }>(
    "/internal/agents/:agentId/fills",
    async (req, reply) => {
      const agentResult = await query<{ shadow_account: string }>(
        "SELECT shadow_account FROM agents WHERE agent_id = $1",
        [req.params.agentId.toLowerCase()],
      );
      if (agentResult.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const { shadow_account } = agentResult.rows[0]!;
      const result = await query(
        "SELECT * FROM fills WHERE shadow_account = $1 ORDER BY block_number DESC",
        [shadow_account],
      );
      return result.rows;
    },
  );

  app.get<{ Params: { agentId: string } }>(
    "/internal/agents/:agentId/positions",
    async (req, reply) => {
      const agentResult = await query<{ shadow_account: string }>(
        "SELECT shadow_account FROM agents WHERE agent_id = $1",
        [req.params.agentId.toLowerCase()],
      );
      if (agentResult.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const { shadow_account } = agentResult.rows[0]!;
      const result = await query(
        "SELECT * FROM positions WHERE shadow_account = $1",
        [shadow_account],
      );
      return result.rows;
    },
  );

  // ─── Leaderboard ──────────────────────────────────────────────────────────

  app.get("/internal/leaderboard/raw", async () => {
    const result = await query(
      `SELECT DISTINCT ON (shadow_account) *
       FROM leaderboard_snapshots
       ORDER BY shadow_account, snapshot_time DESC`,
    );
    return result.rows;
  });

  // ─── Datapoints ───────────────────────────────────────────────────────────

  app.get("/internal/datapoints", async (req) => {
    const metric = (req.query as Record<string, string>)["metric"];
    const limit = Math.min(Number((req.query as Record<string, string>)["limit"] ?? "200"), 2000);
    const offset = Number((req.query as Record<string, string>)["offset"] ?? "0");

    const params: unknown[] = [];
    let where = "";
    if (metric) {
      params.push(metric);
      where = `WHERE metric = $1 `;
    }
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const result = await query(
      `SELECT * FROM activity_datapoints ${where}
       ORDER BY recorded_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return result.rows;
  });
}
