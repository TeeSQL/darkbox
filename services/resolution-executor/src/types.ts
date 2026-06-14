import type { Address, Hex } from "viem";

/**
 * On-chain intent types emitted by Ocean's market-closing lane (PR #22) on
 * `market_lifecycle_actions.onchain_intent.type`.
 *
 *  - `resolveMarket` — settle to a definite YES/NO outcome.
 *  - `voidMarket`    — settle the market as Invalid (refund / void).
 *  - `closeMarket`   — stop trading (Active/Paused -> Closed); no outcome. This
 *                      is a precursor to resolution, not a settlement itself.
 */
export type IntentType = "resolveMarket" | "voidMarket" | "closeMarket";

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
