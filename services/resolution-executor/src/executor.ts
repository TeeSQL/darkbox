import type { DecisionSource } from "./decisionSource.js";
import type { MarketResolver } from "./resolver.js";
import type { PendingResolution } from "./types.js";

export interface ExecutorDeps {
  resolver: MarketResolver;
  source: DecisionSource;
  /** How many pending resolutions to pull per poll. */
  fetchLimit?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

function defaultLog(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[resolution-executor] ${msg}`, extra);
  else console.log(`[resolution-executor] ${msg}`);
}

export type ProcessOutcome = "resolved" | "already-resolved" | "skipped" | "failed";

/**
 * SAFETY GATE. Decide whether an intent carries an EXPLICIT, valid outcome that
 * we are allowed to execute. A missing/ambiguous/mismatched outcome is rejected
 * here — it is never inferred or defaulted.
 *
 *  - resolveMarket MUST carry Yes or No.
 *  - voidMarket    MUST carry Invalid.
 *  - closeMarket   carries no outcome (it is not a settlement).
 */
export function validateIntent(intent: PendingResolution): { ok: true } | { ok: false; reason: string } {
  switch (intent.intentType) {
    case "resolveMarket":
      if (intent.outcome === "Yes" || intent.outcome === "No") return { ok: true };
      return {
        ok: false,
        reason: `resolveMarket requires an explicit Yes/No outcome, got ${JSON.stringify(intent.outcome)}`,
      };
    case "voidMarket":
      if (intent.outcome === "Invalid") return { ok: true };
      return {
        ok: false,
        reason: `voidMarket requires the Invalid outcome, got ${JSON.stringify(intent.outcome)}`,
      };
    case "closeMarket":
      if (intent.outcome === null) return { ok: true };
      return {
        ok: false,
        reason: `closeMarket must not carry an outcome, got ${JSON.stringify(intent.outcome)}`,
      };
    default:
      return { ok: false, reason: `unknown intentType ${JSON.stringify(intent.intentType)}` };
  }
}

/**
 * Process a single pending resolution end-to-end:
 *   validate (safety) -> idempotency skip -> resolve on-chain -> markResolved.
 *
 * Never throws: a validation failure is SKIPPED + flagged via markFailed (never
 * resolved/defaulted); a per-item on-chain/source error is recorded via
 * markFailed so the loop keeps going. Returns the outcome category.
 */
export async function processResolution(
  intent: PendingResolution,
  deps: ExecutorDeps,
): Promise<ProcessOutcome> {
  const log = deps.log ?? defaultLog;
  const marketId = intent.marketId;

  // --- SAFETY: only execute an explicit, valid outcome. ---
  const valid = validateIntent(intent);
  if (!valid.ok) {
    log("SKIP ambiguous/invalid outcome (flagging, NOT resolving)", {
      marketId,
      intentType: intent.intentType,
      reason: valid.reason,
    });
    try {
      await deps.source.markFailed(marketId, valid.reason);
    } catch (markErr) {
      const m = markErr instanceof Error ? markErr.message : String(markErr);
      log("markFailed ALSO failed (will retry next poll)", { marketId, error: m });
    }
    return "skipped";
  }

  try {
    // --- Idempotency: never resolve a market that is already terminal. ---
    if (await deps.resolver.isAlreadyResolved(intent)) {
      log("already resolved on-chain — skipping tx, marking done", {
        marketId,
        intentType: intent.intentType,
      });
      await deps.source.markResolved(marketId, { txHash: null });
      return "already-resolved";
    }

    // --- Execute the EXPLICIT decision on-chain. ---
    const { txHash } = await deps.resolver.resolveMarket(intent);
    log("resolved on-chain", {
      marketId,
      intentType: intent.intentType,
      outcome: intent.outcome,
      txHash,
    });
    await deps.source.markResolved(marketId, { txHash });
    return "resolved";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("resolution FAILED", { marketId, intentType: intent.intentType, error: message });
    try {
      await deps.source.markFailed(marketId, message);
    } catch (markErr) {
      const m = markErr instanceof Error ? markErr.message : String(markErr);
      log("markFailed ALSO failed (will retry next poll)", { marketId, error: m });
    }
    return "failed";
  }
}

/**
 * One poll iteration: fetch pending resolutions and process each. Per-item
 * errors are contained in `processResolution`, so this resolves even if some
 * items fail. Throws only if the *fetch* itself fails (the loop catches it).
 */
export async function runOnce(deps: ExecutorDeps): Promise<number> {
  const pending = await deps.source.getPendingResolutions();
  let processed = 0;
  for (const intent of pending) {
    await processResolution(intent, deps);
    processed += 1;
  }
  return processed;
}

/**
 * The forever poll loop. Catches and logs per-iteration errors (e.g. the
 * indexer/RPC not being up yet) and keeps going — it never hard-exits.
 */
export async function runLoop(deps: ExecutorDeps, pollIntervalMs: number): Promise<never> {
  const log = deps.log ?? defaultLog;
  for (;;) {
    try {
      await runOnce(deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("poll iteration error (continuing)", { error: message });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
