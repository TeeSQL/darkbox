import {
  deriveShadowAccount,
  hashWithdrawCommand,
  recoverWithdrawCommandSigner,
  type BridgeDomainParams,
  type WithdrawCommand,
} from "@darkbox/shared";
import { getAddress, type Address, type Hex } from "viem";

export type WithdrawValidationError =
  | "bad_signature"
  | "wrong_owner"
  | "expired_deadline"
  | "mapping_mismatch"
  | "zero_amount"
  | "wrong_shadow_chain"
  | "unsupported_destination";

/** A public escrow the service operates (e.g. Base or Arc). */
export interface SupportedDestination {
  chainId: bigint;
  bridge: Address;
}

export interface WithdrawValidationContext {
  domain: BridgeDomainParams;
  gameId: Hex;
  shadowChainId: bigint;
  /** Current unix seconds, for deadline checks. */
  now: number;
  /**
   * Resolves the canonical shadow account for an owner. Defaults to the
   * deterministic derivation (spec 1.1) but can be overridden by a registry.
   */
  resolveShadowAccount?: (owner: Address) => Hex;
  /**
   * Destinations the service can pay out to (Base + Arc for MVP). When set, the
   * command's (destinationChainId, destinationBridge) must be one of them, so
   * garbage destinations are rejected before any shadow burn. The public bridge
   * enforces the same binding on-chain via `destinationChainId == block.chainid`.
   */
  supportedDestinations?: readonly SupportedDestination[];
}

export interface WithdrawValidationOk {
  ok: true;
  /** withdrawalId == userCommandHash (spec 1.1). */
  withdrawalId: Hex;
  command: WithdrawCommand;
}

export interface WithdrawValidationFail {
  ok: false;
  error: WithdrawValidationError;
}

export type WithdrawValidationResult =
  | WithdrawValidationOk
  | WithdrawValidationFail;

/**
 * Validates a user-signed EIP-712 `WithdrawCommand` before any shadow burn
 * (spec sections 7.2–7.4). Checks signature, owner recovery, deadline, the
 * owner<->shadow mapping, and the bound shadow chain id. Returns the canonical
 * `withdrawalId` on success.
 *
 * Does NOT check withdrawable balance — that is enforced atomically by the
 * shadow controller's `burnForWithdrawal` (spec 7.3).
 */
export async function validateWithdrawCommand(
  ctx: WithdrawValidationContext,
  command: WithdrawCommand,
  signature: Hex,
): Promise<WithdrawValidationResult> {
  if (command.amount <= 0n) return { ok: false, error: "zero_amount" };

  if (command.deadline < BigInt(ctx.now)) {
    return { ok: false, error: "expired_deadline" };
  }

  if (command.shadowChainId !== ctx.shadowChainId) {
    return { ok: false, error: "wrong_shadow_chain" };
  }

  if (ctx.supportedDestinations && ctx.supportedDestinations.length > 0) {
    const ok = ctx.supportedDestinations.some(
      (d) =>
        d.chainId === command.destinationChainId &&
        d.bridge.toLowerCase() === command.destinationBridge.toLowerCase(),
    );
    if (!ok) return { ok: false, error: "unsupported_destination" };
  }

  let recovered: Address;
  try {
    recovered = await recoverWithdrawCommandSigner(ctx.domain, command, signature);
  } catch {
    return { ok: false, error: "bad_signature" };
  }
  if (getAddress(recovered) !== getAddress(command.owner)) {
    return { ok: false, error: "wrong_owner" };
  }

  const expectedShadow = ctx.resolveShadowAccount
    ? ctx.resolveShadowAccount(command.owner)
    : deriveShadowAccount(ctx.gameId, command.owner);
  if (expectedShadow.toLowerCase() !== command.shadowAccount.toLowerCase()) {
    return { ok: false, error: "mapping_mismatch" };
  }

  return {
    ok: true,
    withdrawalId: hashWithdrawCommand(ctx.domain, command),
    command,
  };
}
