import type { Address, Hex } from "viem";
import type { IntentType, Outcome, PendingResolution } from "./types.js";

/**
 * ABSTRACTED decision source.
 *
 * The worker does NOT decide outcomes. The decisions are produced by Ocean's
 * market-closing lane (PR #22), which writes `market_lifecycle_actions` rows
 * carrying an `onchain_intent`. #22 is NOT merged to main yet, so this interface
 * is the seam: the executor only ever talks to a `DecisionSource`, and the real
 * HTTP wiring (below) can be finalized when #22 lands without touching the
 * resolver or the loop.
 *
 * Contract:
 *  - getPendingResolutions(): approved, not-yet-executed resolutions.
 *  - markResolved(marketId, { txHash }): record success (txHash null on an
 *    idempotent skip where no new tx was sent).
 *  - markFailed(marketId, error): record a per-item failure or a SKIPPED +
 *    flagged ambiguous outcome — so it surfaces for a human and is not silently
 *    retried forever / silently defaulted.
 */
export interface DecisionSource {
  getPendingResolutions(): Promise<PendingResolution[]>;
  markResolved(marketId: string, info: { txHash: Hex | null }): Promise<void>;
  markFailed(marketId: string, error: string): Promise<void>;
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
    case "closeMarket":
      return raw;
    default:
      return null;
  }
}

/**
 * One `market_lifecycle_actions` row as documented for PR #22. Only the fields
 * the executor needs are typed; extra columns are tolerated. `onchain_intent` is
 * the JSON payload describing what to execute on-chain.
 */
export interface MarketLifecycleActionRow {
  market_id: string;
  market_address?: string;
  action_type?: string; // 'prepare_resolution'
  tx_hash?: string | null;
  onchain_intent?: {
    type?: string; // 'resolveMarket' | 'voidMarket' | 'closeMarket'
    outcome?: string; // 'Yes' | 'No' | 'Invalid' (absent for closeMarket)
    marketAddress?: string;
  } | null;
}

/**
 * Map a raw #22 row into a `PendingResolution`. Returns null when the row is
 * structurally unusable (no market id/address or unknown intent type) — those
 * are dropped, distinct from a known intent with an ambiguous OUTCOME, which is
 * kept (outcome=null) so the executor can SKIP + flag it. Exported for tests.
 */
export function mapActionRowToIntent(row: MarketLifecycleActionRow): PendingResolution | null {
  const intentType = normalizeIntentType(row.onchain_intent?.type);
  if (!intentType) return null;

  const marketAddress = (row.onchain_intent?.marketAddress ?? row.market_address) as
    | Address
    | undefined;
  if (!row.market_id || !marketAddress) return null;

  // closeMarket carries no outcome by design; resolve/void carry one we
  // normalize. An unrecognized outcome stays null so it is skipped + flagged.
  const outcome =
    intentType === "closeMarket" ? null : normalizeOutcome(row.onchain_intent?.outcome);

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
  /** Max rows to pull per poll. */
  fetchLimit?: number;
}

/**
 * HTTP wiring against the indexer's internal API, matching the documented PR #22
 * contract. PROVISIONAL until #22 merges — the request/response shapes here are
 * the seam to adjust then; nothing else in the service should need to change.
 *
 * Poll:     GET  /internal/markets?action_type=prepare_resolution&pending=true
 *           (equivalently: market_lifecycle_actions WHERE action_type =
 *            'prepare_resolution' AND tx_hash IS NULL)
 * Complete: POST /internal/markets/:id/complete-resolution
 *             { actorId, actorRole: 'admin', txHash }
 * Failure:  POST /internal/markets/:id/resolution-failed
 *             { actorId, actorRole: 'admin', error }   // best-effort flag
 */
export class HttpDecisionSource implements DecisionSource {
  private readonly internalUrl: string;
  private readonly actorId: string;
  private readonly fetchLimit: number;

  constructor(cfg: HttpDecisionSourceConfig) {
    this.internalUrl = cfg.internalUrl.replace(/\/$/, "");
    this.actorId = cfg.actorId;
    this.fetchLimit = cfg.fetchLimit ?? 25;
  }

  async getPendingResolutions(): Promise<PendingResolution[]> {
    const url =
      `${this.internalUrl}/markets` +
      `?action_type=prepare_resolution&pending=true&limit=${this.fetchLimit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`decisionSource getPendingResolutions failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as MarketLifecycleActionRow[];
    if (!Array.isArray(rows)) return [];
    const intents: PendingResolution[] = [];
    for (const row of rows) {
      const intent = mapActionRowToIntent(row);
      if (intent) intents.push(intent);
    }
    return intents;
  }

  async markResolved(marketId: string, info: { txHash: Hex | null }): Promise<void> {
    const res = await fetch(
      `${this.internalUrl}/markets/${encodeURIComponent(marketId)}/complete-resolution`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: this.actorId, actorRole: "admin", txHash: info.txHash }),
      },
    );
    if (!res.ok) {
      throw new Error(`decisionSource markResolved failed: ${res.status} ${await res.text()}`);
    }
  }

  async markFailed(marketId: string, error: string): Promise<void> {
    const res = await fetch(
      `${this.internalUrl}/markets/${encodeURIComponent(marketId)}/resolution-failed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: this.actorId, actorRole: "admin", error }),
      },
    );
    if (!res.ok) {
      throw new Error(`decisionSource markFailed failed: ${res.status} ${await res.text()}`);
    }
  }
}
