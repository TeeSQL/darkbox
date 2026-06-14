/** Deposit lifecycle states (spec section 6.2). */
export enum DepositState {
  ObservedPublicDeposit = "observed_public_deposit",
  ConfirmedPublicDeposit = "confirmed_public_deposit",
  MappingResolved = "mapping_resolved",
  ShadowMintSubmitted = "shadow_mint_submitted",
  ShadowMinted = "shadow_minted",
  FailedNeedsReconcile = "failed_needs_reconcile",
}

/** Withdrawal lifecycle states (spec section 7.1). */
export enum WithdrawalState {
  Requested = "requested",
  UserSigned = "user_signed",
  ShadowBurnSubmitted = "shadow_burn_submitted",
  ShadowBurned = "shadow_burned",
  RebalanceRequired = "rebalance_required",
  RebalanceSubmitted = "rebalance_submitted",
  DestinationFunded = "destination_funded",
  ServiceSigned = "service_signed",
  SubmittedPublicWithdrawal = "submitted_public_withdrawal",
  Withdrawn = "withdrawn",
  RejectedInsufficientAvailable = "rejected_insufficient_available",
  FailedNeedsReconcile = "failed_needs_reconcile",
}

/** Deposit-intent lifecycle (spec section 6.5). */
export enum DepositIntentState {
  Open = "open",
  Matched = "matched",
  Expired = "expired",
}

/** Faucet mint lifecycle for promo/daemon shadow-USDC allocations. */
export enum FaucetMintState {
  Pending = "pending",
  Minting = "minting",
  Minted = "minted",
  Failed = "failed",
}

/** Allowed forward transitions for the deposit state machine. */
export const DEPOSIT_TRANSITIONS: Record<DepositState, DepositState[]> = {
  [DepositState.ObservedPublicDeposit]: [
    DepositState.ConfirmedPublicDeposit,
    DepositState.FailedNeedsReconcile,
  ],
  [DepositState.ConfirmedPublicDeposit]: [
    DepositState.MappingResolved,
    DepositState.FailedNeedsReconcile,
  ],
  [DepositState.MappingResolved]: [
    DepositState.ShadowMintSubmitted,
    DepositState.FailedNeedsReconcile,
  ],
  [DepositState.ShadowMintSubmitted]: [
    DepositState.ShadowMinted,
    DepositState.FailedNeedsReconcile,
  ],
  [DepositState.ShadowMinted]: [],
  [DepositState.FailedNeedsReconcile]: [
    DepositState.MappingResolved,
    DepositState.ShadowMintSubmitted,
    DepositState.ShadowMinted,
  ],
};

/** Allowed forward transitions for the withdrawal state machine. */
export const WITHDRAWAL_TRANSITIONS: Record<WithdrawalState, WithdrawalState[]> = {
  [WithdrawalState.Requested]: [
    WithdrawalState.UserSigned,
    WithdrawalState.RejectedInsufficientAvailable,
  ],
  [WithdrawalState.UserSigned]: [
    WithdrawalState.ShadowBurnSubmitted,
    WithdrawalState.RejectedInsufficientAvailable,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.ShadowBurnSubmitted]: [
    WithdrawalState.ShadowBurned,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.ShadowBurned]: [
    WithdrawalState.RebalanceRequired,
    WithdrawalState.RebalanceSubmitted,
    WithdrawalState.DestinationFunded,
    WithdrawalState.ServiceSigned,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.RebalanceRequired]: [
    WithdrawalState.RebalanceSubmitted,
    WithdrawalState.DestinationFunded,
    WithdrawalState.ServiceSigned,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.RebalanceSubmitted]: [
    WithdrawalState.DestinationFunded,
    WithdrawalState.ServiceSigned,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.DestinationFunded]: [
    WithdrawalState.ServiceSigned,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.ServiceSigned]: [
    WithdrawalState.SubmittedPublicWithdrawal,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.SubmittedPublicWithdrawal]: [
    WithdrawalState.Withdrawn,
    WithdrawalState.FailedNeedsReconcile,
  ],
  [WithdrawalState.Withdrawn]: [],
  [WithdrawalState.RejectedInsufficientAvailable]: [],
  [WithdrawalState.FailedNeedsReconcile]: [
    WithdrawalState.ShadowBurnSubmitted,
    WithdrawalState.ShadowBurned,
    WithdrawalState.RebalanceRequired,
    WithdrawalState.RebalanceSubmitted,
    WithdrawalState.DestinationFunded,
    WithdrawalState.ServiceSigned,
    WithdrawalState.SubmittedPublicWithdrawal,
    WithdrawalState.Withdrawn,
  ],
};

export function canTransitionDeposit(from: DepositState, to: DepositState): boolean {
  return DEPOSIT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionWithdrawal(
  from: WithdrawalState,
  to: WithdrawalState,
): boolean {
  return WITHDRAWAL_TRANSITIONS[from]?.includes(to) ?? false;
}
