import type { Address, Hex } from "viem";

/**
 * Settlement intent types this worker executes. These are the only
 * `onchain_intent.type` values that ever reach the executor, because the feed
 * is sourced from markets whose `lifecycle_status === 'resolution_pending'`, and
 * #22 only ever writes a `prepare_resolution` action for those — whose intent is
 * `resolveMarket` (Yes/No) or `voidMarket` (Invalid).
 *
 *  - `resolveMarket` — settle to a definite YES/NO outcome.
 *  - `voidMarket`    — settle the market as Invalid (refund / void).
 *
 * NOTE: `closeMarket` is deliberately NOT a settlement intent here. Closing
 * (Active/Paused -> Closed) is owned by the indexer close route + the expiry
 * worker; it must never be sourced or written back via complete-resolution
 * (that route is settlement-only). See decisionSource.ts / executor.ts.
 */
export type IntentType = "resolveMarket" | "voidMarket";

/**
 * The EXPLICIT, already-approved outcome an intent settles to. This worker does
 * NOT decide outcomes — it only executes a decision someone else already made.
 * `null` means the decision source did not supply an unambiguous outcome; such
 * an intent is SKIPPED and flagged, never defaulted.
 */
export type Outcome = "Yes" | "No" | "Invalid";

/** `Outcome` -> on-chain `Outcome` enum value (MarketTypes.sol). */
export const OUTCOME_CODE: Record<Outcome, number> = {
  Yes: 1,
  No: 2,
  Invalid: 3,
};

/** MarketStatus enum (MarketTypes.sol). */
export const MarketStatus = {
  Draft: 0,
  Active: 1,
  Paused: 2,
  Closed: 3,
  Resolved: 4,
  Voided: 5,
} as const;

/**
 * One approved resolution to execute on-chain. Produced by a `DecisionSource`
 * (see decisionSource.ts) from a `market_lifecycle_actions` row.
 */
export interface PendingResolution {
  /** bytes32 market id (factory key). */
  marketId: Hex;
  /** Deployed `DarkBoxBinaryMarket` address — used only for the idempotency read. */
  marketAddress: Address;
  intentType: IntentType;
  /** Explicit outcome, or null/absent when the source gave none (=> skipped). */
  outcome: Outcome | null;
}
