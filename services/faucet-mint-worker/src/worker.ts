import type { FaucetCoordinator } from "@darkbox/bridge";
import { FaucetMintState } from "@darkbox/shared";

export interface DrainResult {
  /** Records attempted this iteration. */
  processed: number;
  /** Records that reached `minted` (newly minted OR recovered). */
  minted: number;
  /** Records that ended in `failed`. */
  failed: number;
}

export interface DrainDeps {
  coordinator: FaucetCoordinator;
  /** Max pending records to drain per iteration. */
  fetchLimit?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

function defaultLog(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[faucet-mint-worker] ${msg}`, extra);
  else console.log(`[faucet-mint-worker] ${msg}`);
}

/**
 * One drain iteration: pull pending faucet mints and process each through the
 * coordinator, keyed by `operationId`.
 *
 * `FaucetCoordinator.process` already contains its own try/catch — a per-record
 * mint failure marks that record `failed` and RESOLVES (never throws), so a
 * single bad grant can never abort the batch or crash the loop. We still guard
 * each record defensively in case the store itself misbehaves.
 *
 * Throws only if the initial `listPending` fetch fails (the loop catches it).
 */
export async function runOnce(deps: DrainDeps): Promise<DrainResult> {
  const log = deps.log ?? defaultLog;
  const pending = deps.coordinator.listPending(deps.fetchLimit ?? 25);
  const result: DrainResult = { processed: 0, minted: 0, failed: 0 };

  for (const record of pending) {
    result.processed += 1;
    try {
      const out = await deps.coordinator.process(record.operationId);
      if (out.state === FaucetMintState.Minted) {
        result.minted += 1;
        log("minted faucet grant", {
          operationId: out.operationId,
          kind: out.kind,
          txHash: out.txHash,
        });
      } else if (out.state === FaucetMintState.Failed) {
        result.failed += 1;
        log("faucet grant FAILED (will retry next poll)", {
          operationId: out.operationId,
          kind: out.kind,
          error: out.error,
        });
      }
    } catch (err) {
      // Defensive: process() shouldn't throw, but never let one record kill the
      // batch. The record stays pending/minting and is retried next iteration.
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      log("unexpected error processing record (continuing)", {
        operationId: record.operationId,
        error: message,
      });
    }
  }

  return result;
}

/**
 * The forever drain loop. Catches and logs per-iteration errors (e.g. the hidden
 * RPC not being up yet) and keeps going — it NEVER hard-exits.
 */
export async function runLoop(deps: DrainDeps, pollIntervalMs: number): Promise<never> {
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
