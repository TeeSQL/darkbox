import type { Hex } from "viem";
import type { WithdrawCommand, WithdrawalAuthorization } from "./eip712.js";
import type {
  WithdrawCommandWire,
  WithdrawalAuthorizationWire,
} from "./schemas.js";

export type AgentId = `0x${string}`;
export type GameId = `0x${string}`;

export interface LeaderboardEntry {
  agentId: AgentId;
  ensName: string;
  startingBalance: string;
  currentEquity: string;
  pnl: string;
  rank: number;
}

export * from "./agent/runtime.js";
export * from "./eip712.js";
export * from "./states.js";
export * from "./idempotency.js";
export * from "./schemas.js";
export * from "./signing.js";

/** Decode a wire `WithdrawCommand` (decimal strings) into bigint form. */
export function decodeWithdrawCommand(w: WithdrawCommandWire): WithdrawCommand {
  return {
    gameId: w.gameId as Hex,
    owner: w.owner as `0x${string}`,
    shadowAccount: w.shadowAccount as Hex,
    amount: BigInt(w.amount),
    recipient: w.recipient as `0x${string}`,
    destinationChainId: BigInt(w.destinationChainId),
    destinationBridge: w.destinationBridge as `0x${string}`,
    nonce: BigInt(w.nonce),
    deadline: BigInt(w.deadline),
    shadowChainId: BigInt(w.shadowChainId),
  };
}

/** Encode a bigint `WithdrawCommand` to wire form. */
export function encodeWithdrawCommand(c: WithdrawCommand): WithdrawCommandWire {
  return {
    gameId: c.gameId,
    owner: c.owner,
    shadowAccount: c.shadowAccount,
    amount: c.amount.toString(),
    recipient: c.recipient,
    destinationChainId: c.destinationChainId.toString(),
    destinationBridge: c.destinationBridge,
    nonce: c.nonce.toString(),
    deadline: c.deadline.toString(),
    shadowChainId: c.shadowChainId.toString(),
  };
}

export function decodeWithdrawalAuthorization(
  w: WithdrawalAuthorizationWire,
): WithdrawalAuthorization {
  return {
    gameId: w.gameId as Hex,
    owner: w.owner as `0x${string}`,
    shadowAccount: w.shadowAccount as Hex,
    amount: BigInt(w.amount),
    recipient: w.recipient as `0x${string}`,
    destinationChainId: BigInt(w.destinationChainId),
    destinationBridge: w.destinationBridge as `0x${string}`,
    userCommandHash: w.userCommandHash as Hex,
    shadowBurnRef: w.shadowBurnRef as Hex,
    nonce: BigInt(w.nonce),
    deadline: BigInt(w.deadline),
  };
}

export function encodeWithdrawalAuthorization(
  a: WithdrawalAuthorization,
): WithdrawalAuthorizationWire {
  return {
    gameId: a.gameId,
    owner: a.owner,
    shadowAccount: a.shadowAccount,
    amount: a.amount.toString(),
    recipient: a.recipient,
    destinationChainId: a.destinationChainId.toString(),
    destinationBridge: a.destinationBridge,
    userCommandHash: a.userCommandHash,
    shadowBurnRef: a.shadowBurnRef,
    nonce: a.nonce.toString(),
    deadline: a.deadline.toString(),
  };
}
