import type { Address, Hex } from "viem";
import type { IntentType, Outcome, PendingResolution } from "./types.js";

/**
 * ABSTRACTED decision source.
 *
 * The worker does NOT decide outcomes. The decisions are produced by the indexer
 * market-lifecycle lane (#22, merged): an admin `prepare-resolution` validates an
 * outcome, flips the market to `lifecycle_status='resolution_pending'`, and writes
 * a `market_lifecycle_actions` row (`action_type='prepare_resolution'`) carrying an
 * `onchain_intent`. The executor only ever talks to a `DecisionSource`; the HTTP
 * wiring below targets the REAL #22 internal API.
 *
 * Contract:
 *  - getPendingResolutions(): markets currently in `resolution_pending`, each
 *    mapped from its latest `prepare_resolution` action's `onchain_intent`.
 *  - markResolved(marketId, { txHash }): settlement write-back — POST the REAL
 *    on-chain tx hash to `complete-resolution`. `txHash` is ALWAYS a 32-byte hash
 *    (never null): a null write-back is a 400 against the real contract.
 *
 * There is intentionally NO markFailed: #22 exposes no resolution-failed route.
 * A skip/failure simply leaves the market in `resolution_pending`, which IS the
 * durable "needs attention" signal (see executor.ts). We never invent a route.
 */
export interface DecisionSource {
  getPendingResolutions(): Promise<PendingResolution[]>;
  markResolved(marketId: string, info: { txHash: Hex }): Promise<void>;
}

/**
 * Normalize a raw outcome label from #22 into our strict `Outcome` union.
 * ANYTHING unrecognized -> null, which the executor treats as ambiguous and
 * SKIPS (never defaults). Exported for unit testing the mapping.
 */
export function normalizeOutcome(raw: unknown): Outcome | null {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase()) {
    case "yes":
      return "Yes";
    case "no":
      return "No";
    case "invalid":
    case "void":
      return "Invalid";
    default:
      return null;
  }
}

function normalizeIntentType(raw: unknown): IntentType | null {
  switch (raw) {
    case "resolveMarket":
    case "voidMarket":
      return raw;
    // NOTE: 'closeMarket' is intentionally NOT accepted here. Closing is the
    // indexer close route + expiry worker's job; it must never be sourced as a
    // settlement nor written back via complete-resolution. (bug 4)
    default:
      return null;
  }
}

/**
 * One `market_lifecycle_actions` row from the real #22 internal API. Only the
 * fields the executor needs are typed; extra columns are tolerated.
 * `onchain_intent` is the jsonb payload #22's `prepareResolution` writes.
 */
export interface MarketLifecycleActionRow {
  market_id: string;
  market_address?: string | null;
  action_type?: string; // we read the latest 'prepare_resolution'
  onchain_intent?: {
    type?: string; // 'resolveMarket' | 'voidMarket'
    outcome?: string; // 'Yes' | 'No' | 'Invalid'
    marketAddress?: string | null;
  } | null;
}

/**
 * One row from `GET /internal/markets` (the real #22 contract returns SELECT *).
 * Only the fields the feed needs are typed.
 */
export interface MarketRow {
  market_id: string;
  market_address?: string | null;
  lifecycle_status?: string | null;
  resolved_outcome?: string | null;
}

/**
 * Map a `prepare_resolution` action row into a `PendingResolution`. Returns null
 * when the row is structurally unusable (no market id/address or unknown intent
 * type) — those are dropped, distinct from a known intent with an ambiguous
 * OUTCOME, which is kept (outcome=null) so the executor can SKIP + flag it.
 * Exported for tests.
 */
export function mapActionRowToIntent(row: MarketLifecycleActionRow): PendingResolution | null {
  const intentType = normalizeIntentType(row.onchain_intent?.type);
  if (!intentType) return null;

  const marketAddress = (row.onchain_intent?.marketAddress ?? row.market_address) as
    | Address
    | undefined;
  if (!row.market_id || !marketAddress) return null;

  // resolve/void carry an outcome we normalize. An unrecognized outcome stays
  // null so the executor skips + leaves it pending for a human.
  const outcome = normalizeOutcome(row.onchain_intent?.outcome);

  return {
    marketId: row.market_id as Hex,
    marketAddress,
    intentType,
    outcome,
  };
}

export interface HttpDecisionSourceConfig {
  /** Indexer internal base URL WITHOUT trailing slash, e.g. http://host:8080/internal */
  internalUrl: string;
  /** Recorded on complete-resolution as the acting principal. */
  actorId: string;
}

/** 32-byte tx-hash shape the #22 complete-resolution route enforces. */
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * HTTP wiring against the REAL #22 indexer internal API.
 *
 * Poll (the feed is markets in `resolution_pending`, mapped from their latest
 * `prepare_resolution` action — there is no `?pending=` query param on #22):
 *   GET  /internal/markets                         -> all markets (SELECT *)
 *   GET  /internal/markets/:id/lifecycle-actions   -> actions, newest first
 * Settlement write-back (resolve/void ONLY):
 *   POST /internal/markets/:id/complete-resolution
 *        { actorId, actorRole: 'ocean_operator', txHash }   // 32-byte txHash
 *
 * No failure route exists in #22, and `closeMarket` is never sourced, so neither
 * a resolution-failed POST nor a close write-back is ever made here.
 */
export class HttpDecisionSource implements DecisionSource {
  private readonly internalUrl: string;
  private readonly actorId: string;

  constructor(cfg: HttpDecisionSourceConfig) {
    this.internalUrl = cfg.internalUrl.replace(/\/$/, "");
    this.actorId = cfg.actorId;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`decisionSource GET ${url} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async getPendingResolutions(): Promise<PendingResolution[]> {
    // 1) All markets, keep only those awaiting on-chain settlement.
    const markets = await this.getJson<MarketRow[]>(`${this.internalUrl}/markets`);
    const pendingMarkets = (Array.isArray(markets) ? markets : []).filter(
      (m) => m?.lifecycle_status === "resolution_pending",
    );

    // 2) For each, take the latest prepare_resolution action's onchain_intent.
    // Because we source ONLY resolution_pending markets, the intent is always
    // resolveMarket/voidMarket — closeMarket can never enter the feed (bug 4).
    const intents: PendingResolution[] = [];
    for (const market of pendingMarkets) {
      const actions = await this.getJson<MarketLifecycleActionRow[]>(
        `${this.internalUrl}/markets/${encodeURIComponent(market.market_id)}/lifecycle-actions`,
      );
      const latestPrepare = (Array.isArray(actions) ? actions : []).find(
        (a) => a?.action_type === "prepare_resolution",
      );
      if (!latestPrepare) continue;
      const intent = mapActionRowToIntent({
        ...latestPrepare,
        market_id: latestPrepare.market_id ?? market.market_id,
        market_address: latestPrepare.market_address ?? market.market_address,
      });
      if (intent) intents.push(intent);
    }
    return intents;
  }

  async markResolved(marketId: string, info: { txHash: Hex }): Promise<void> {
    // The #22 complete-resolution route 400s on a non-32-byte hash; guard here so
    // a bug upstream surfaces as a clear error instead of a silent skip (bug 3).
    if (!TX_HASH_RE.test(info.txHash)) {
      throw new Error(
        `decisionSource markResolved requires a 32-byte tx hash, got ${JSON.stringify(info.txHash)}`,
      );
    }
    const res = await fetch(
      `${this.internalUrl}/markets/${encodeURIComponent(marketId)}/complete-resolution`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actorId: this.actorId,
          actorRole: "ocean_operator",
          txHash: info.txHash,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`decisionSource markResolved failed: ${res.status} ${await res.text()}`);
    }
  }
}
