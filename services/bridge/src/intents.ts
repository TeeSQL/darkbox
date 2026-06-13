import { DepositIntentState } from "@darkbox/shared";
import type { DepositIntent, DepositObservation } from "./types.js";

/**
 * Attempts to match a confirmed deposit observation to an open deposit intent
 * (spec section 6.5). Matching is FIFO by intent creation time; one intent
 * matches at most one operation and vice versa.
 *
 * An intent matches only if ALL hold:
 *  - asset matches
 *  - amount >= minAmount
 *  - observed at/before expiresAt
 *  - expectedFrom, when set, equals the sender
 *
 * @param observedAt unix seconds the operation was observed
 * @param openIntents open intents, already sorted FIFO by createdAt
 * @returns the matching intent, or undefined if none match
 */
export function matchIntent(
  observation: DepositObservation,
  openIntents: DepositIntent[],
  observedAt: number,
): DepositIntent | undefined {
  for (const intent of openIntents) {
    if (intent.state !== DepositIntentState.Open) continue;
    if (intent.asset.toLowerCase() !== observation.asset.toLowerCase()) continue;
    if (observation.amount < intent.minAmount) continue;
    if (observedAt > intent.expiresAt) continue;
    if (
      intent.expectedFrom &&
      intent.expectedFrom.toLowerCase() !== observation.from.toLowerCase()
    ) {
      continue;
    }
    return intent;
  }
  return undefined;
}

/** Marks intents whose `expiresAt` has passed as expired (spec 6.5). */
export function expireIntents(
  openIntents: DepositIntent[],
  now: number,
): DepositIntent[] {
  const expired: DepositIntent[] = [];
  for (const intent of openIntents) {
    if (intent.state === DepositIntentState.Open && now > intent.expiresAt) {
      expired.push({ ...intent, state: DepositIntentState.Expired });
    }
  }
  return expired;
}
