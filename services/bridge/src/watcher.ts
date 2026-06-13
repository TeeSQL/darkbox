import {
  depositOpId,
  depositOperationString,
  NATIVE_ASSET,
  type DepositOperationKey,
} from "@darkbox/shared";
import type { Address, Hex } from "viem";
import type { DepositObservation } from "./types.js";

/**
 * Raw events emitted by the public chain that the watcher normalizes into a
 * {@link DepositObservation}. Each variant corresponds to a supported deposit
 * path (spec section 6.1).
 */
export type RawDepositEvent =
  | {
      kind: "native_receive"; // direct ETH send / receive()
      from: Address;
      amount: bigint;
      txHash: Hex;
      logIndex: number;
      confirmations: number;
    }
  | {
      kind: "erc20_transfer"; // direct USDC Transfer(from, bridge, amount)
      asset: Address;
      from: Address;
      amount: bigint;
      txHash: Hex;
      logIndex: number;
      confirmations: number;
    }
  | {
      kind: "deposit_event"; // explicit deposit(...) call -> DepositReceived
      asset: Address;
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
 * Normalizes any supported raw deposit event into a canonical
 * {@link DepositObservation} carrying its idempotency key (spec 6.4).
 *
 * Beneficiary defaults:
 *  - native receive: `from`
 *  - erc20 transfer: `from` (an intent may later re-route it; section 6.5)
 *  - explicit deposit: the `beneficiary` argument (already defaulted onchain)
 */
export function normalizeDepositEvent(
  ctx: WatcherContext,
  event: RawDepositEvent,
): DepositObservation {
  let asset: Address;
  let from: Address;
  let beneficiary: Address;

  switch (event.kind) {
    case "native_receive":
      asset = NATIVE_ASSET;
      from = event.from;
      beneficiary = event.from;
      break;
    case "erc20_transfer":
      asset = event.asset;
      from = event.from;
      beneficiary = event.from;
      break;
    case "deposit_event":
      asset = event.asset;
      from = event.from;
      beneficiary = event.beneficiary;
      break;
  }

  const key: DepositOperationKey = {
    chainId: ctx.chainId,
    bridgeAddress: ctx.bridgeAddress,
    asset,
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
    asset,
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
