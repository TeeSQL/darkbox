import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { normalizeQuestion, sanitizeBillboardMessage } from "@darkbox/shared";
import { query, withTransaction } from "../db.js";
import { config } from "../config.js";
import { parseMarketCloseTimeSeconds } from "../marketProposalDefaults.js";



type AgentTurnBody = {
  runId?: string;
  strategy?: string;
  agentId?: string;
  turn?: number;
  ok?: boolean;
  latencyMs?: number;
  identity?: { address?: string; shadowAccount?: string };
  observationSummary?: unknown;
  output?: {
    tradeActions?: Array<Record<string, unknown>>;
    billboardPost?: { message?: string } | null;
    marketProposal?: Record<string, unknown> | null;
    reason?: string;
  };
};

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function decimalLike(value: unknown, fallback = "0"): string {
  const text = asText(value, fallback);
  return /^\d+(?:\.\d+)?$/.test(text) ? text : fallback;
}

function agentShadowAccount(agentId: string, identity?: AgentTurnBody["identity"]): string {
  if (identity?.shadowAccount) return identity.shadowAccount.toLowerCase();
  return `v0:${agentId.toLowerCase()}`;
}

function agentOwnerAddress(agentId: string, identity?: AgentTurnBody["identity"]): string {
  if (identity?.address) return identity.address.toLowerCase();
  return `v0:${agentId.toLowerCase()}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function proposalActor(body: Record<string, unknown>, prefix: "proposer" | "actor" = "proposer") {
  const telegramId = asText(body[`${prefix}TelegramId`]);
  const role = asText(body[`${prefix}Role`], telegramId ? "group_member" : "");
  return {
    kind: asText(body[`${prefix}Kind`], telegramId ? "telegram" : "internal"),
    id: asText(body[`${prefix}Id`], telegramId),
    telegramId,
    telegramUsername: asText(body[`${prefix}TelegramUsername`]),
    role,
  };
}

async function ensureV0Market(client: import("pg").PoolClient, marketId: string): Promise<void> {
  const normalized = marketId.toLowerCase();
  const ts = nowSeconds();
  await client.query(
    `INSERT INTO markets (
       market_id, game_id, creator_address, market_address, question, metadata_uri,
       close_time, resolve_by, resolver_type, status, yes_book, no_book,
       created_at_block, created_at_ts
     ) VALUES ($1, $2, $3, $4, $5, '', 0, 0, 'AdminManual', 'Active', $6, $7, 0, $8)
     ON CONFLICT (market_id) DO NOTHING`,
    [
      normalized,
      "v0-agent-runtime",
      "v0:system",
      `v0:market:${normalized}`,
      `V0 market ${normalized}`,
      `v0:book:${normalized}:yes`,
      `v0:book:${normalized}:no`,
      ts,
    ],
  );
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/health", async () => {
    return {
      status: "ok",
      service: "darkbox-indexer",
      endpoint: "internal",
    };
  });


  app.post<{ Body: AgentTurnBody }>("/internal/v0/agent-turns", async (req, reply) => {
    const body = req.body ?? {};
    const agentId = asText(body.agentId).toLowerCase();
    if (!agentId) return reply.status(400).send({ error: "agentId is required" });

    const runId = asText(body.runId, "v0");
    const turn = Number.isInteger(body.turn) ? Number(body.turn) : 0;
    const strategy = asText(body.strategy, "unknown");
    const ok = body.ok !== false;
    const latencyMs = Number.isFinite(body.latencyMs) ? Number(body.latencyMs) : 0;
    const output = body.output ?? {};
    const actions = Array.isArray(output.tradeActions) ? output.tradeActions : [];
    const ownerAddress = agentOwnerAddress(agentId, body.identity);
    const shadowAccount = agentShadowAccount(agentId, body.identity);
    const ts = nowSeconds();

    const result = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO agents (
           agent_id, game_id, owner_address, shadow_account, ens_name,
           instruction_hash, runtime_hash, reveal_salt_hash,
           registered_at_block, registered_at_ts
         ) VALUES ($1, 'v0-agent-runtime', $2, $3, '', 'v0', 'v0', 'v0', 0, $4)
         ON CONFLICT (agent_id) DO UPDATE SET
           owner_address = EXCLUDED.owner_address,
           shadow_account = EXCLUDED.shadow_account`,
        [agentId, ownerAddress, shadowAccount, ts],
      );

      await client.query(
        `INSERT INTO balances (shadow_account, asset, total_deposited, current_balance)
         VALUES ($1, 'v0-usdc', '1000', '1000')
         ON CONFLICT (shadow_account, asset) DO NOTHING`,
        [shadowAccount],
      );

      await client.query(
        `INSERT INTO agent_turns (run_id, agent_id, turn, strategy, ok, latency_ms, observation_summary, output)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         ON CONFLICT (run_id, agent_id, turn) DO UPDATE SET
           ok = EXCLUDED.ok,
           latency_ms = EXCLUDED.latency_ms,
           observation_summary = EXCLUDED.observation_summary,
           output = EXCLUDED.output`,
        [runId, agentId, turn, strategy, ok, latencyMs, JSON.stringify(body.observationSummary ?? {}), JSON.stringify(output)],
      );

      let ordersCreated = 0;
      let ordersCancelled = 0;
      for (const action of actions) {
        const type = asText(action["type"]);
        if (type === "make_order") {
          const marketId = asText(action["marketId"], "v0-market").toLowerCase();
          const outcome = asText(action["outcome"], "YES").toUpperCase() === "NO" ? "NO" : "YES";
          const side = asText(action["side"], "buy") === "sell" ? "ask" : "bid";
          const price = decimalLike(action["price"], "0.50");
          const size = decimalLike(action["size"], "1");
          const bookAddress = `v0:book:${marketId}:${outcome.toLowerCase()}`;
          const positionId = `v0-${runId}-${agentId}-${turn}-${ordersCreated}-${randomUUID()}`;
          await ensureV0Market(client, marketId);
          await client.query(
            `INSERT INTO orders (
               chain_id, book_address, position_id, owner_address, shadow_account, market_id,
               side, token0, token1, lower_tick, upper_tick, liquidity, status,
               placed_at_block, placed_at_ts
             ) VALUES (0, $1, $2, $3, $4, $5, $6, $7, 'v0-usdc', $8, $8, $9, 'open', 0, $10)`,
            [bookAddress, positionId, ownerAddress, shadowAccount, marketId, side, outcome, Math.round(Number(price) * 1_000_000), size, ts],
          );
          ordersCreated += 1;
        } else if (type === "cancel_order") {
          const orderId = asText(action["orderId"]);
          if (orderId) {
            const updated = await client.query(
              `UPDATE orders SET status='cancelled', updated_at=NOW()
               WHERE shadow_account=$1 AND (position_id=$2 OR id::text=$2) AND status='open'`,
              [shadowAccount, orderId],
            );
            ordersCancelled += updated.rowCount ?? 0;
          }
        }
      }

      // ── Billboard (defense-in-depth) ──────────────────────────────────────
      // The Python agents already gate + sanitize, but the indexer is the trust
      // boundary for any client: re-sanitize and drop hidden-state leaks.
      let billboardCreated = false;
      let billboardRejected: string | null = null;
      if (output.billboardPost?.message) {
        const sanitized = sanitizeBillboardMessage(output.billboardPost.message);
        if (sanitized.ok) {
          await client.query(
            `INSERT INTO billboards (message_id, agent_id, message, run_id, turn)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (message_id) DO UPDATE SET message = EXCLUDED.message`,
            [`${runId}-${agentId}-${turn}`, agentId, sanitized.message, runId, turn],
          );
          billboardCreated = true;
        } else {
          billboardRejected = sanitized.reason === "hidden_state_leak"
            ? `hidden_state_leak:${sanitized.leakPattern ?? "unknown"}`
            : sanitized.reason ?? "rejected";
        }
      }

      // ── Market proposal (confirmation queue only, deduped, never on-chain) ─
      // Proposals are written ONLY to the market_proposals queue with status
      // 'proposed'. This path NEVER creates a markets row from a proposal —
      // market creation requires a separate executor/admin factory deploy.
      let proposalCreated = false;
      let proposalRejected: string | null = null;
      const proposal = output.marketProposal;
      if (proposal && typeof proposal === "object") {
        const question = asText(proposal["question"]);
        if (question) {
          const normalized = normalizeQuestion(question);
          const existing = await client.query<{ question: string }>(
            `SELECT question FROM market_proposals WHERE status IN ('proposed','confirmed','approved','deployed')
             UNION ALL
             SELECT question FROM markets`,
          );
          const isDuplicate = existing.rows.some((row) => normalizeQuestion(asText(row.question)) === normalized);
          if (isDuplicate) {
            proposalRejected = "duplicate";
          } else {
            await client.query(
              `INSERT INTO market_proposals (
                 proposal_id, agent_id, question, description, outcomes, resolve_by,
                 resolution_source, rationale, status, run_id, turn, proposer_kind,
                 proposer_id, resolver_type, close_time
               ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'proposed', $9, $10, 'agent', $2, 'AdminManual', $11)
               ON CONFLICT (proposal_id) DO NOTHING`,
              [
                `${runId}-${agentId}-${turn}`,
                agentId,
                question,
                asText(proposal["description"]),
                JSON.stringify(proposal["outcomes"] ?? ["YES", "NO"]),
                asText(proposal["resolveBy"]),
                asText(proposal["resolutionSource"], "DarkBox admin manual"),
                asText(proposal["rationale"]),
                runId,
                turn,
                parseMarketCloseTimeSeconds(proposal["closeTime"] ?? proposal["expiry"]),
              ],
            );
            await client.query(
              `INSERT INTO market_proposal_audit (
                 proposal_id, from_status, to_status, actor_kind, actor_id,
                 actor_role, note
               ) VALUES ($1, '', 'proposed', 'agent', $2, 'agent', 'agent_turn_proposal')`,
              [`${runId}-${agentId}-${turn}`, agentId],
            );
            proposalCreated = true;
          }
        }
      }

      await client.query(
        `UPDATE aggregate_stats SET value = (SELECT COUNT(*)::text FROM agents), updated_at=NOW()
         WHERE key='active_agents'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (SELECT COUNT(*)::text FROM markets WHERE status='Active'), updated_at=NOW()
         WHERE key='active_markets'`,
      );
      await client.query(
        `UPDATE aggregate_stats SET value = (SELECT COUNT(*)::text FROM orders WHERE status='open'), updated_at=NOW()
         WHERE key='positions_opened'`,
      );

      return { ordersCreated, ordersCancelled, billboardCreated, billboardRejected, proposalCreated, proposalRejected };
    });

    return { status: "ok", agentId, runId, turn, ...result };
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

  // ─── ETHGlobal context (internal agent/operator feed) ────────────────────

  app.get("/internal/context/ethglobal", async () => {
    const events = await query(
      `SELECT e.*,
              COALESCE(p.project_count, 0)::int AS project_count,
              r.id AS latest_run_id,
              r.status AS latest_run_status,
              r.error AS latest_run_error,
              r.created_at AS latest_run_created_at
       FROM ethglobal_events e
       LEFT JOIN (
         SELECT event_slug, COUNT(*) AS project_count
         FROM ethglobal_projects
         GROUP BY event_slug
       ) p ON p.event_slug = e.event_slug
       LEFT JOIN LATERAL (
         SELECT id, status, error, created_at
         FROM ethglobal_ingest_runs
         WHERE event_slug = e.event_slug
         ORDER BY created_at DESC
         LIMIT 1
       ) r ON TRUE
       ORDER BY e.updated_at DESC`,
    );
    return events.rows;
  });

  app.get<{ Params: { eventSlug: string } }>(
    "/internal/context/ethglobal/:eventSlug/projects",
    async (req) => {
      const limit = Math.min(Number((req.query as Record<string, string>)["limit"] ?? "500"), 1000);
      const search = asText((req.query as Record<string, string>)["q"]);
      const params: unknown[] = [req.params.eventSlug.toLowerCase()];
      let where = "WHERE event_slug = $1";
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (name ILIKE $${params.length} OR shortest_description ILIKE $${params.length})`;
      }
      params.push(limit);

      const result = await query(
        `SELECT event_slug, external_project_id, external_project_slug, name,
                shortest_description, sponsors, prizes, source_url, raw_summary,
                fetched_at, updated_at
         FROM ethglobal_projects
         ${where}
         ORDER BY name ASC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows;
    },
  );

  app.get<{ Params: { eventSlug: string; idOrSlug: string } }>(
    "/internal/context/ethglobal/:eventSlug/projects/:idOrSlug",
    async (req, reply) => {
      const result = await query(
        `SELECT event_slug, external_project_id, external_project_slug, name,
                shortest_description, sponsors, prizes, source_url, raw_summary,
                fetched_at, updated_at
         FROM ethglobal_projects
         WHERE event_slug = $1
           AND (external_project_slug = $2 OR external_project_id = $2)`,
        [req.params.eventSlug.toLowerCase(), req.params.idOrSlug.toLowerCase()],
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "ETHGlobal project not found" });
      }
      return result.rows[0];
    },
  );

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

  // Credited-balance read keyed by shadow account, used by the gateway to
  // reconcile a deposit order against on-chain settlement. Sums across assets
  // (one stablecoin in this game) so it's robust to asset-naming drift between
  // services. Amounts are micro-USDC (uint as decimal string); zeros when the
  // shadow account has no balance row yet.
  app.get<{ Params: { shadowAccount: string } }>(
    "/internal/balances/:shadowAccount",
    async (req) => {
      const shadowAccount = req.params.shadowAccount.toLowerCase();
      const result = await query<{ total_deposited: string; current_balance: string }>(
        `SELECT
           COALESCE(SUM(total_deposited::numeric), 0)::text AS total_deposited,
           COALESCE(SUM(current_balance::numeric), 0)::text AS current_balance
         FROM balances WHERE shadow_account = $1`,
        [shadowAccount],
      );
      const row = result.rows[0];
      return {
        shadowAccount,
        totalDepositedMicro: row?.total_deposited ?? "0",
        currentBalanceMicro: row?.current_balance ?? "0",
      };
    },
  );

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


  // ─── Market proposal confirmation gate ────────────────────────────────────

  app.get("/internal/market-proposals", async (req) => {
    const status = (req.query as Record<string, string>)["status"];
    const limit = Math.min(Number((req.query as Record<string, string>)["limit"] ?? "100"), 500);
    const params: unknown[] = [];
    let where = "";
    if (status) {
      params.push(status);
      where = "WHERE status = $1";
    }
    params.push(limit);
    const result = await query(
      `SELECT * FROM market_proposals ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  });

  app.post<{ Body: Record<string, unknown> }>("/internal/market-proposals", async (req, reply) => {
    const body = req.body ?? {};
    const proposalId = asText(body["proposalId"]);
    const question = asText(body["question"]);
    if (!proposalId || !question) return reply.status(400).send({ error: "proposalId and question are required" });
    const review = (body["review"] && typeof body["review"] === "object") ? body["review"] as Record<string, unknown> : {};
    const proposer = proposalActor(body);
    const closeTime = parseMarketCloseTimeSeconds(body["closeTime"] ?? body["expiry"]);
    await withTransaction(async (client) => {
      const existing = await client.query<{ status: string }>(
        "SELECT status FROM market_proposals WHERE proposal_id = $1",
        [proposalId],
      );
      await client.query(
      `INSERT INTO market_proposals (
         proposal_id, agent_id, question, description, outcomes, resolve_by,
         resolution_source, rationale, metadata_uri, run_id, turn,
         review_chat_id, review_thread_id, review_message_id, proposer_kind,
         proposer_id, proposer_telegram_id, proposer_telegram_username,
         proposer_role, resolver_type, close_time
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'AdminManual', $20)
       ON CONFLICT (proposal_id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         question = EXCLUDED.question,
         description = EXCLUDED.description,
         outcomes = EXCLUDED.outcomes,
         resolve_by = EXCLUDED.resolve_by,
         resolution_source = EXCLUDED.resolution_source,
         rationale = EXCLUDED.rationale,
         metadata_uri = EXCLUDED.metadata_uri,
         run_id = EXCLUDED.run_id,
         turn = EXCLUDED.turn,
         review_chat_id = EXCLUDED.review_chat_id,
         review_thread_id = EXCLUDED.review_thread_id,
         review_message_id = EXCLUDED.review_message_id,
         proposer_kind = EXCLUDED.proposer_kind,
         proposer_id = EXCLUDED.proposer_id,
         proposer_telegram_id = EXCLUDED.proposer_telegram_id,
         proposer_telegram_username = EXCLUDED.proposer_telegram_username,
         proposer_role = EXCLUDED.proposer_role,
         resolver_type = 'AdminManual',
         close_time = EXCLUDED.close_time`,
      [
        proposalId,
        asText(body["agentId"]),
        question,
        asText(body["description"]),
        JSON.stringify(body["outcomes"] ?? ["YES", "NO"]),
        asText(body["resolveBy"]),
        asText(body["resolutionSource"], "DarkBox admin manual"),
        asText(body["rationale"]),
        asText(body["metadataURI"]),
        asText(body["runId"]),
        Number.isInteger(body["turn"]) ? Number(body["turn"]) : 0,
        asText(review["chatId"]),
        asText(review["threadId"]),
        asText(review["messageId"]),
        proposer.kind,
        proposer.id,
        proposer.telegramId,
        proposer.telegramUsername,
        proposer.role,
        closeTime,
      ],
      );
      await client.query(
        `INSERT INTO market_proposal_audit (
           proposal_id, from_status, to_status, actor_kind, actor_id,
           actor_telegram_id, actor_telegram_username, actor_role,
           review_chat_id, review_message_id, note
         ) VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9, 'proposal_upsert')`,
        [
          proposalId,
          existing.rows[0]?.status ?? "",
          proposer.kind,
          proposer.id,
          proposer.telegramId,
          proposer.telegramUsername,
          proposer.role,
          asText(review["chatId"]),
          asText(review["messageId"]),
        ],
      );
    });
    return { status: "ok", proposalId, resolverType: "AdminManual", closeTime };
  });

  app.post<{ Params: { proposalId: string }; Body: Record<string, unknown> }>(
    "/internal/market-proposals/:proposalId/decision",
    async (req, reply) => {
      const status = asText(req.body?.["status"]);
      if (status !== "confirmed" && status !== "approved" && status !== "denied") {
        return reply.status(400).send({ error: "status must be confirmed, approved, or denied" });
      }
      const actor = proposalActor(req.body ?? {}, "actor");
      const reviewedBy = asText(req.body?.["reviewedBy"], actor.id || actor.telegramId);
      const reviewMessageId = asText(req.body?.["reviewMessageId"]);
      const row = await withTransaction(async (client) => {
        const existing = await client.query<{ status: string }>(
          "SELECT status FROM market_proposals WHERE proposal_id = $1",
          [req.params.proposalId],
        );
        if (existing.rows.length === 0) return null;
        const result = await client.query(
          `UPDATE market_proposals
           SET status = $2,
               reviewed_by = $3,
               reviewed_at = CASE WHEN $2 IN ('approved','denied') THEN NOW() ELSE reviewed_at END,
               review_message_id = COALESCE(NULLIF($4, ''), review_message_id),
               confirmer_telegram_id = CASE WHEN $2 = 'confirmed' THEN $5 ELSE confirmer_telegram_id END,
               confirmer_telegram_username = CASE WHEN $2 = 'confirmed' THEN $6 ELSE confirmer_telegram_username END,
               confirmed_at = CASE WHEN $2 = 'confirmed' THEN NOW() ELSE confirmed_at END,
               operator_telegram_id = CASE WHEN $7 IN ('operator','admin') THEN $5 ELSE operator_telegram_id END
           WHERE proposal_id = $1
           RETURNING *`,
          [
            req.params.proposalId,
            status,
            reviewedBy,
            reviewMessageId,
            actor.telegramId,
            actor.telegramUsername,
            actor.role,
          ],
        );
        await client.query(
          `INSERT INTO market_proposal_audit (
             proposal_id, from_status, to_status, actor_kind, actor_id,
             actor_telegram_id, actor_telegram_username, actor_role,
             review_message_id, note
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'decision')`,
          [
            req.params.proposalId,
            existing.rows[0]?.status ?? "",
            status,
            actor.kind,
            actor.id || reviewedBy,
            actor.telegramId,
            actor.telegramUsername,
            actor.role,
            reviewMessageId,
          ],
        );
        return result.rows[0] ?? null;
      });
      if (!row) return reply.status(404).send({ error: "proposal not found" });
      return row;
    },
  );

  // ─── Market-executor deployment write-back ────────────────────────────────
  // Called by services/market-executor after it creates the on-chain market via
  // DarkBoxMarketFactory.createMarket. In one transaction: flip the proposal to
  // 'deployed' (+ deploy metadata) AND upsert the canonical markets row. The
  // game_id comes from the indexer's own GAME_ID config (proposals don't carry
  // one); resolver_type is always 'AdminManual' (the only resolver the factory
  // accepts). Idempotent: re-posting the same proposal/market is a no-op insert.
  app.post<{ Params: { proposalId: string }; Body: Record<string, unknown> }>(
    "/internal/market-proposals/:proposalId/deployed",
    async (req, reply) => {
      const body = req.body ?? {};
      const marketId = asText(body["marketId"]).toLowerCase();
      const marketAddress = asText(body["marketAddress"]).toLowerCase();
      if (!marketId || !marketAddress) {
        return reply.status(400).send({ error: "marketId and marketAddress are required" });
      }
      const txHash = asText(body["txHash"]);
      const yesBook = asText(body["yesBook"]).toLowerCase();
      const noBook = asText(body["noBook"]).toLowerCase();
      const yesToken = asText(body["yesToken"]).toLowerCase();
      const noToken = asText(body["noToken"]).toLowerCase();
      // The creator is the executor's coordinator address (factory owner); it
      // sends it so the indexer needn't know the coordinator key/address.
      const creatorAddress = asText(body["creatorAddress"], "0x0000000000000000000000000000000000000000").toLowerCase();
      // bigint-as-string from the executor (JSON-safe); pg coerces the numeric
      // string into BIGINT. Default "0" preserves the old behavior if absent.
      const closeTime = asText(body["closeTime"], "0");
      const resolveBy = asText(body["resolveBy"], "0");
      const createdAtBlock = asText(body["createdAtBlock"], "0");
      const ts = nowSeconds();

      const result = await withTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE market_proposals
             SET status = 'deployed',
                 market_id = $2,
                 deploy_tx_hash = NULLIF($3, ''),
                 deploy_error = NULL,
                 deployed_at = NOW()
           WHERE proposal_id = $1
             AND status IN ('approved', 'deployed')
           RETURNING proposal_id, question, description, metadata_uri`,
          [req.params.proposalId, marketId, txHash],
        );
        if (updated.rows.length === 0) return null;
        const proposal = updated.rows[0] as Record<string, unknown>;

        await client.query(
          `INSERT INTO markets (
             market_id, game_id, creator_address, market_address, question, metadata_uri,
             close_time, resolve_by, resolver_type, status, yes_token, no_token,
             yes_book, no_book, created_at_block, created_at_ts
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AdminManual', 'Active', $9, $10, $11, $12, $13, $14)
           ON CONFLICT (market_id) DO NOTHING`,
          [
            marketId,
            config.gameId,
            creatorAddress,
            marketAddress,
            asText(proposal["question"]),
            asText(proposal["metadata_uri"]),
            closeTime,
            resolveBy,
            yesToken || null,
            noToken || null,
            yesBook || null,
            noBook || null,
            createdAtBlock,
            ts,
          ],
        );

        await client.query(
          `UPDATE aggregate_stats SET value = (SELECT COUNT(*)::text FROM markets WHERE status='Active'), updated_at=NOW()
           WHERE key='active_markets'`,
        );

        return proposal;
      });

      if (!result) return reply.status(404).send({ error: "proposal not found" });
      return { status: "ok", proposalId: req.params.proposalId, marketId };
    },
  );

  app.post<{ Params: { proposalId: string }; Body: Record<string, unknown> }>(
    "/internal/market-proposals/:proposalId/deploy-failed",
    async (req, reply) => {
      const error = asText(req.body?.["error"], "unknown deploy error");
      const result = await query(
        `UPDATE market_proposals
           SET status = 'deploy_failed', deploy_error = $2
         WHERE proposal_id = $1
         RETURNING proposal_id`,
        [req.params.proposalId, error],
      );
      if (result.rows.length === 0) return reply.status(404).send({ error: "proposal not found" });
      return { status: "ok", proposalId: req.params.proposalId };
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
