import {
  depositOpId,
  depositOperationString,
  type DepositOperationKey,
} from "@darkbox/shared";
import type { Address, Hex } from "viem";
import type { DepositObservation } from "./types.js";

/**
 * Raw events emitted by the public chain that the watcher normalizes into a
 * {@link DepositObservation}. USDC-only MVP: the asset is always the configured
 * USDC, so it is implicit. A live watcher only feeds USDC `Transfer`-to-bridge
 * logs and `DepositReceived` events here; other token transfers are ignored at
 * the source (filtered by the USDC token address).
 */
export type RawDepositEvent =
  | {
      kind: "erc20_transfer"; // direct USDC Transfer(from, bridge, amount)
      from: Address;
      amount: bigint;
      txHash: Hex;
      logIndex: number;
      confirmations: number;
    }
  | {
      kind: "deposit_event"; // explicit deposit(...) call -> DepositReceived
      from: Address;
      beneficiary: Address;
      amount: bigint;
      txHash: Hex;
      logIndex: number;
      confirmations: number;
    };

export interface WatcherContext {
  chainId: number;
  bridgeAddress: Address;
}

/**
 * Normalizes a raw deposit event into a canonical {@link DepositObservation}
 * carrying its idempotency key (spec 6.4).
 *
 * Beneficiary defaults:
 *  - erc20 transfer: `from` (an intent may later re-route it; section 6.5)
 *  - explicit deposit: the `beneficiary` argument (already defaulted onchain)
 */
export function normalizeDepositEvent(
  ctx: WatcherContext,
  event: RawDepositEvent,
): DepositObservation {
  let from: Address;
  let beneficiary: Address;

  switch (event.kind) {
    case "erc20_transfer":
      from = event.from;
      beneficiary = event.from;
      break;
    case "deposit_event":
      from = event.from;
      beneficiary = event.beneficiary;
      break;
  }

  const key: DepositOperationKey = {
    chainId: ctx.chainId,
    bridgeAddress: ctx.bridgeAddress,
    txHash: event.txHash,
    logIndex: event.logIndex,
    from,
    beneficiary,
    amount: event.amount,
  };

  return {
    depositOpId: depositOpId(key),
    operationString: depositOperationString(key),
    chainId: ctx.chainId,
    amount: event.amount,
    from,
    beneficiary,
    txHash: event.txHash,
    logIndex: event.logIndex,
    confirmations: event.confirmations,
  };
}

/**
 * Abstract watcher source. A live implementation polls/subscribes to the
 * public chain; the test implementation replays a fixed list of raw events.
 */
export interface DepositWatcherSource {
  /** Returns any newly observed raw deposit events since the last poll. */
  poll(): Promise<RawDepositEvent[]>;
}
