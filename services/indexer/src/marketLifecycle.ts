import type pg from "pg";
import { randomUUID } from "node:crypto";

export type ActorRole = "admin" | "ocean_operator" | "expiry_worker";
export type MarketOutcome = "Yes" | "No" | "Invalid";

export type OperatorActionInput = {
  actionId?: string;
  actorId: string;
  actorRole: ActorRole;
  reason?: string;
  now?: Date;
};

export type ResolveInput = OperatorActionInput & {
  outcome: MarketOutcome;
  evidence: string;
  source: string;
  confirmed: boolean;
};

export type CompleteResolutionInput = OperatorActionInput & {
  txHash: string;
};

type MarketRow = {
  market_id: string;
  market_address?: string | null;
  resolver_type?: string | null;
  status?: string | null;
  lifecycle_status?: string | null;
  expires_at?: string | number | null;
};

type LifecycleResult = {
  status: "noop" | "closed" | "resolution_pending" | "resolved";
  marketId: string;
  actionId: string;
  onchainIntent?: Record<string, unknown>;
};

const NY_TIME_ZONE = "America/New_York";
const MAX_LOCAL_TO_UTC_ITERATIONS = 8;

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function nyParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

function compareLocal(a: ReturnType<typeof nyParts>, target: { year: number; month: number; day: number; hour: number; minute: number; second: number }): number {
  const av = [a.year, a.month, a.day, a.hour, a.minute, a.second];
  const bv = [target.year, target.month, target.day, target.hour, target.minute, target.second];
  for (let i = 0; i < av.length; i += 1) {
    if (av[i]! < bv[i]!) return -1;
    if (av[i]! > bv[i]!) return 1;
  }
  return 0;
}

function utcForNewYorkLocal(target: { year: number; month: number; day: number; hour: number; minute: number; second: number }): Date {
  let guess = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  for (let i = 0; i < MAX_LOCAL_TO_UTC_ITERATIONS; i += 1) {
    const parts = nyParts(new Date(guess));
    const renderedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const wantedAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
    const delta = wantedAsUtc - renderedAsUtc;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  return new Date(guess);
}

function addDaysLocal(parts: ReturnType<typeof nyParts>, days: number) {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  const shifted = nyParts(utcForNewYorkLocal({
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: 12,
    minute: 0,
    second: 0,
  }));
  return { year: shifted.year, month: shifted.month, day: shifted.day };
}

export function defaultMarketExpiry(from: Date = new Date()): Date {
  const parts = nyParts(from);
  const dayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let daysUntilSunday = (7 - (dayIndex[parts.weekday] ?? 0)) % 7;
  const candidateBase = addDaysLocal(parts, daysUntilSunday);
  const candidateLocal = { ...candidateBase, hour: 17, minute: 0, second: 0 };
  if (compareLocal(parts, candidateLocal) >= 0) {
    daysUntilSunday = daysUntilSunday === 0 ? 7 : daysUntilSunday + 7;
  }
  const targetBase = addDaysLocal(parts, daysUntilSunday);
  return utcForNewYorkLocal({ ...targetBase, hour: 17, minute: 0, second: 0 });
}

export function defaultMarketExpirySeconds(from: Date = new Date()): number {
  return unixSeconds(defaultMarketExpiry(from));
}

function requireOperator(input: OperatorActionInput): void {
  if (!input.actorId) throw new Error("actorId is required");
  if (input.actorRole !== "admin" && input.actorRole !== "ocean_operator") {
    throw new Error("actorRole must be admin or ocean_operator");
  }
}

function requireAdmin(input: OperatorActionInput): void {
  if (!input.actorId) throw new Error("actorId is required");
  if (input.actorRole !== "admin") throw new Error("resolution requires admin actorRole");
}

async function getMarket(client: pg.PoolClient, marketId: string): Promise<MarketRow | null> {
  const result = await client.query<MarketRow>(
    `SELECT market_id, market_address, resolver_type, status, lifecycle_status, expires_at
     FROM markets WHERE market_id=$1`,
    [marketId.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

async function insertAction(
  client: pg.PoolClient,
  values: {
    actionId: string;
    marketId: string;
    actionType: string;
    actorId: string;
    actorRole: ActorRole;
    reason?: string;
    outcome?: string;
    evidence?: string;
    source?: string;
    txHash?: string;
    onchainIntent?: Record<string, unknown>;
    now: Date;
  },
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO market_lifecycle_actions (
       action_id, market_id, action_type, actor_id, actor_role, reason,
       outcome, evidence, source, tx_hash, onchain_intent, created_at_ts
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     ON CONFLICT (action_id) DO NOTHING`,
    [
      values.actionId,
      values.marketId,
      values.actionType,
      values.actorId,
      values.actorRole,
      values.reason ?? "",
      values.outcome,
      values.evidence,
      values.source,
      values.txHash,
      JSON.stringify(values.onchainIntent ?? {}),
      unixSeconds(values.now),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function closeMarket(
  client: pg.PoolClient,
  marketId: string,
  input: OperatorActionInput,
): Promise<LifecycleResult> {
  requireOperator(input);
  const id = marketId.toLowerCase();
  const actionId = input.actionId ?? `close:${id}:${randomUUID()}`;
  const now = input.now ?? new Date();
  const market = await getMarket(client, id);
  if (!market) throw new Error("market not found");

  const inserted = await insertAction(client, {
    actionId,
    marketId: id,
    actionType: "close",
    actorId: input.actorId,
    actorRole: input.actorRole,
    reason: input.reason ?? "operator close",
    onchainIntent: { type: "closeMarket", marketId: id, marketAddress: market.market_address ?? null },
    now,
  });

  const result = await client.query(
    `UPDATE markets
     SET lifecycle_status='closed',
         status='Closed',
         closed_at=COALESCE(closed_at, $2),
         close_actor_id=COALESCE(close_actor_id, $3),
         close_action_id=COALESCE(close_action_id, $4),
         updated_at=NOW()
     WHERE market_id=$1 AND lifecycle_status IN ('active','paused')
     RETURNING market_id`,
    [id, unixSeconds(now), input.actorId, actionId],
  );

  return { status: result.rows.length > 0 || inserted ? "closed" : "noop", marketId: id, actionId };
}

export async function closeExpiredMarkets(
  client: pg.PoolClient,
  now: Date = new Date(),
  actorId = "system:market-expiry-worker",
): Promise<Array<LifecycleResult>> {
  const nowTs = unixSeconds(now);
  const candidates = await client.query<{ market_id: string; expires_at: string }>(
    `SELECT market_id, expires_at FROM markets
     WHERE lifecycle_status IN ('active','paused') AND expires_at > 0 AND expires_at <= $1
     ORDER BY expires_at ASC, market_id ASC`,
    [nowTs],
  );

  const results: Array<LifecycleResult> = [];
  for (const row of candidates.rows) {
    const actionId = `expiry-close:${row.market_id}:${row.expires_at}`;
    const inserted = await insertAction(client, {
      actionId,
      marketId: row.market_id,
      actionType: "close_expired",
      actorId,
      actorRole: "expiry_worker",
      reason: "market expiry reached",
      onchainIntent: { type: "closeMarket", marketId: row.market_id, trigger: "expires_at" },
      now,
    });
    const updated = await client.query(
      `UPDATE markets
       SET lifecycle_status='closed',
           status='Closed',
           closed_at=COALESCE(closed_at, $2),
           close_actor_id=COALESCE(close_actor_id, $3),
           close_action_id=COALESCE(close_action_id, $4),
           updated_at=NOW()
       WHERE market_id=$1 AND lifecycle_status IN ('active','paused')
       RETURNING market_id`,
      [row.market_id, nowTs, actorId, actionId],
    );
    results.push({ status: updated.rows.length > 0 || inserted ? "closed" : "noop", marketId: row.market_id, actionId });
  }
  return results;
}

export async function prepareResolution(
  client: pg.PoolClient,
  marketId: string,
  input: ResolveInput,
): Promise<LifecycleResult> {
  requireAdmin(input);
  if (!input.confirmed) throw new Error("confirmed=true is required for resolution");
  if (!input.evidence.trim()) throw new Error("evidence is required");
  if (!input.source.trim()) throw new Error("source is required");

  const id = marketId.toLowerCase();
  const actionId = input.actionId ?? `resolve:${id}:${randomUUID()}`;
  const now = input.now ?? new Date();
  const market = await getMarket(client, id);
  if (!market) throw new Error("market not found");
  if ((market.resolver_type ?? "AdminManual") !== "AdminManual") {
    throw new Error("only AdminManual resolver_type is supported");
  }

  const onchainIntent = {
    type: input.outcome === "Invalid" ? "voidMarket" : "resolveMarket",
    marketId: id,
    marketAddress: market.market_address ?? null,
    outcome: input.outcome,
    evidence: input.evidence,
    source: input.source,
    signing: "pending-external-signer",
  };

  const inserted = await insertAction(client, {
    actionId,
    marketId: id,
    actionType: "prepare_resolution",
    actorId: input.actorId,
    actorRole: input.actorRole,
    reason: input.reason ?? "admin confirmed outcome",
    outcome: input.outcome,
    evidence: input.evidence,
    source: input.source,
    onchainIntent,
    now,
  });

  const result = await client.query(
    `UPDATE markets
     SET lifecycle_status='resolution_pending',
         status='Closed',
         closed_at=COALESCE(closed_at, $2),
         outcome=$3,
         resolved_outcome=$3,
         evidence=$4,
         resolution_source=$5,
         resolve_actor_id=$6,
         resolve_action_id=$7,
         updated_at=NOW()
     WHERE market_id=$1 AND lifecycle_status IN ('active','paused','closed','resolution_pending')
     RETURNING market_id`,
    [id, unixSeconds(now), input.outcome, input.evidence, input.source, input.actorId, actionId],
  );

  return {
    status: result.rows.length > 0 || inserted ? "resolution_pending" : "noop",
    marketId: id,
    actionId,
    onchainIntent,
  };
}

export async function completeResolution(
  client: pg.PoolClient,
  marketId: string,
  input: CompleteResolutionInput,
): Promise<LifecycleResult> {
  requireOperator(input);
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.txHash)) throw new Error("txHash must be a 32-byte hex hash");
  const id = marketId.toLowerCase();
  const actionId = input.actionId ?? `resolution-tx:${id}:${input.txHash.toLowerCase()}`;
  const now = input.now ?? new Date();
  const inserted = await insertAction(client, {
    actionId,
    marketId: id,
    actionType: "complete_resolution",
    actorId: input.actorId,
    actorRole: input.actorRole,
    reason: input.reason ?? "resolution transaction recorded",
    txHash: input.txHash.toLowerCase(),
    now,
  });
  const result = await client.query(
    `UPDATE markets
     SET lifecycle_status='resolved',
         status='Resolved',
         resolved_at=COALESCE(resolved_at, $2),
         resolve_tx_hash=COALESCE(resolve_tx_hash, $3),
         resolve_actor_id=COALESCE(resolve_actor_id, $4),
         updated_at=NOW()
     WHERE market_id=$1 AND lifecycle_status IN ('resolution_pending','closed','resolved')
     RETURNING market_id`,
    [id, unixSeconds(now), input.txHash.toLowerCase(), input.actorId],
  );
  return { status: result.rows.length > 0 || inserted ? "resolved" : "noop", marketId: id, actionId };
}
