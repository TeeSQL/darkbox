import type { Address, Hex } from "viem";

/**
 * Submits idempotent shadow mints to the shadow bridge controller after a
 * confirmed public deposit (spec section 6.3 step 6). Implementations wrap a
 * viem wallet client calling `mintShadow(depositOpId, owner, shadowAccount,
 * asset, amount)`.
 */
export interface ShadowMintSubmitter {
  /**
   * Ensures the owner<->shadow mapping exists, then submits the mint.
   * MUST be idempotent on `depositOpId`: a duplicate call returns the existing
   * mint tx without minting again (the controller also reverts on replay).
   */
  mintShadow(params: {
    depositOpId: Hex;
    owner: Address;
    shadowAccount: Hex;
    asset: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }>;

  /** Returns the mint tx hash if `depositOpId` was already minted, else null. */
  findExistingMint(depositOpId: Hex): Promise<Hex | null>;
}

/**
 * Forces a shadow-EVM burn of withdrawable available balance for a withdrawal
 * (spec section 7.3). Implementations call `burnForWithdrawal(withdrawalId,
 * owner, shadowAccount, asset, amount, userCommandHash)`.
 */
export interface ShadowBurnSubmitter {
  /**
   * Burns `amount` of available balance. MUST surface insufficient-available
   * as {@link InsufficientAvailableError} so the coordinator can reject the
   * command (rather than retry). Idempotent on `withdrawalId`.
   */
  burnForWithdrawal(params: {
    withdrawalId: Hex;
    owner: Address;
    shadowAccount: Hex;
    asset: Address;
    amount: bigint;
    userCommandHash: Hex;
  }): Promise<{ shadowBurnRef: Hex }>;

  /** Returns the burn tx hash if `withdrawalId` was already burned, else null. */
  findExistingBurn(withdrawalId: Hex): Promise<Hex | null>;

  /** Current withdrawable available balance for a shadow account/asset. */
  withdrawableBalance(shadowAccount: Hex, asset: Address): Promise<bigint>;
}

/** Thrown by a {@link ShadowBurnSubmitter} when available balance < amount. */
export class InsufficientAvailableError extends Error {
  constructor(
    readonly shadowAccount: Hex,
    readonly asset: Address,
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    super(
      `insufficient available: requested ${requested} but only ${available} withdrawable`,
    );
    this.name = "InsufficientAvailableError";
  }
}
