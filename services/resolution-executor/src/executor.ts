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
 *
 * (closeMarket is not a settlement and is never sourced — see decisionSource.ts.)
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
    default:
      return { ok: false, reason: `unknown intentType ${JSON.stringify(intent.intentType)}` };
  }
}

/**
 * Process a single pending resolution end-to-end:
 *   validate (safety) -> idempotency (real tx) -> resolve on-chain -> markResolved.
 *
 * Never throws. There is no failure write-back route in #22, so a skip or error
 * does NOT advance the market: it is left in `resolution_pending` (the durable
 * "needs attention" signal) and a structured error is logged. Returns the
 * outcome category.
 */
export async function processResolution(
  intent: PendingResolution,
  deps: ExecutorDeps,
): Promise<ProcessOutcome> {
  const log = deps.log ?? defaultLog;
  const marketId = intent.marketId;

  // --- SAFETY: only execute an explicit, valid outcome. ---
  // prepare-resolution validates the outcome upstream, so this is now rare. When
  // it does trip we leave the market pending (no failure route) and log loudly.
  const valid = validateIntent(intent);
  if (!valid.ok) {
    log("SKIP ambiguous/invalid outcome — leaving resolution_pending for manual attention (NOT resolving)", {
      marketId,
      intentType: intent.intentType,
      reason: valid.reason,
    });
    return "skipped";
  }

  try {
    // --- Idempotency: if a settlement tx already exists on-chain, record THAT
    // real hash; never send a second tx and never post a null hash. ---
    const existingTx = await deps.resolver.findExistingResolutionTx(intent);
    if (existingTx) {
      log("already resolved on-chain — recording existing tx (no new tx)", {
        marketId,
        intentType: intent.intentType,
        txHash: existingTx,
      });
      await deps.source.markResolved(marketId, { txHash: existingTx });
      return "already-resolved";
    }

    // --- Execute the EXPLICIT decision on-chain, then write back the real tx. ---
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
    // No failure route: do NOT advance the market. Leaving it in
    // resolution_pending is the signal a human acts on. Log structured + move on.
    const message = err instanceof Error ? err.message : String(err);
    log("resolution FAILED — leaving resolution_pending for manual attention", {
      marketId,
      intentType: intent.intentType,
      error: message,
    });
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
