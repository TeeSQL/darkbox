import {
  WithdrawalState,
  type BridgeDomainParams,
  type WithdrawCommand,
  type WithdrawalAuthorization,
} from "@darkbox/shared";
import type { Hex } from "viem";
import {
  InsufficientAvailableError,
  type ShadowBurnSubmitter,
} from "./shadow.js";
import {
  SigningService,
  SignWithdrawalRejection,
} from "./signingService.js";
import {
  isFundedStatus,
  NoopDestinationLiquidityManager,
  type DestinationLiquidityManager,
  type DestinationLiquidityResult,
  type RebalanceStatus,
} from "./liquidity.js";
import type { BridgeStore } from "./store.js";
import type { WithdrawalRecord } from "./types.js";
import {
  validateWithdrawCommand,
  type WithdrawValidationContext,
} from "./withdrawalValidator.js";

export interface WithdrawalCoordinatorConfig {
  domain: BridgeDomainParams;
  gameId: Hex;
  shadowChainId: bigint;
  resolveShadowAccount?: WithdrawValidationContext["resolveShadowAccount"];
}

export interface WithdrawalResult {
  withdrawalId: Hex;
  status: WithdrawalState;
  shadowBurnRef?: Hex;
  /** Set while a cross-chain rebalance is pending or has failed. */
  rebalance?: DestinationLiquidityResult;
  authorization?: { payload: WithdrawalAuthorization; signature: Hex };
}

/** Maps a rebalance status to the withdrawal state machine (spec 7.1). */
function rebalanceToWithdrawalState(status: RebalanceStatus): WithdrawalState {
  switch (status) {
    case "required":
    case "route_selected":
      return WithdrawalState.RebalanceRequired;
    case "source_transfer_submitted":
      return WithdrawalState.RebalanceSubmitted;
    case "failed_needs_operator_reconcile":
      return WithdrawalState.FailedNeedsReconcile;
    case "destination_funded":
      return WithdrawalState.DestinationFunded;
    case "not_needed":
      return WithdrawalState.ShadowBurned;
  }
}

/**
 * Drives a user withdrawal command through the withdrawal state machine (spec
 * 7.1): validate -> forced shadow burn of available balance -> ensure
 * destination liquidity (rebalance public escrow if needed) -> signing-service
 * authorization. The public `withdraw(...)` submission is performed by the
 * user/client, not here.
 *
 * The strict order matters for the double-spend invariant: the shadow burn
 * always happens BEFORE any public rebalance, and the payout authorization is
 * only issued AFTER the destination escrow is confirmed fundable. When a
 * rebalance is still in flight, `submit` returns a pending result (no
 * authorization) rather than failing — callers re-submit to advance it.
 */
export class WithdrawalCoordinator {
  private readonly liquidity: DestinationLiquidityManager;

  constructor(
    private readonly cfg: WithdrawalCoordinatorConfig,
    private readonly store: BridgeStore,
    private readonly burner: ShadowBurnSubmitter,
    private readonly signingService: SigningService,
    liquidity?: DestinationLiquidityManager,
  ) {
    this.liquidity = liquidity ?? new NoopDestinationLiquidityManager();
  }

  /**
   * Submit (or resume) a withdrawal command.
   * @param now unix seconds for deadline / authorization timestamps.
   */
  async submit(
    command: WithdrawCommand,
    signature: Hex,
    now: number,
  ): Promise<WithdrawalResult> {
    const validation = await validateWithdrawCommand(
      {
        domain: this.cfg.domain,
        gameId: this.cfg.gameId,
        shadowChainId: this.cfg.shadowChainId,
        now,
        resolveShadowAccount: this.cfg.resolveShadowAccount,
      },
      command,
      signature,
    );

    if (!validation.ok) {
      // Validation failures map to a terminal rejected/expired status.
      throw new WithdrawalRejected(validation.error);
    }

    const { withdrawalId } = validation;

    // Idempotent resume: if we already produced an authorization, return it.
    const existing = this.store.getWithdrawal(withdrawalId);
    if (
      existing &&
      existing.state === WithdrawalState.ServiceSigned &&
      existing.authorizationSignature &&
      existing.shadowBurnRef
    ) {
      return {
        withdrawalId,
        status: existing.state,
        shadowBurnRef: existing.shadowBurnRef,
        authorization: this.rebuildAuthorization(existing),
      };
    }

    let record: WithdrawalRecord = existing ?? {
      withdrawalId,
      gameId: command.gameId,
      owner: command.owner,
      shadowAccount: command.shadowAccount,
      amount: command.amount,
      recipient: command.recipient,
      destinationChainId: command.destinationChainId,
      destinationBridge: command.destinationBridge,
      nonce: command.nonce,
      deadline: command.deadline,
      userSignature: signature,
      state: WithdrawalState.UserSigned,
      retries: 0,
    };
    this.store.putWithdrawal(record);

    // --- forced shadow burn of available balance FIRST (spec 7.3) ---
    let shadowBurnRef: Hex;
    try {
      const prior = await this.burner.findExistingBurn(withdrawalId);
      if (prior) {
        shadowBurnRef = prior;
      } else {
        record = this.set(record, WithdrawalState.ShadowBurnSubmitted);
        const res = await this.burner.burnForWithdrawal({
          withdrawalId,
          owner: command.owner,
          shadowAccount: command.shadowAccount,
          amount: command.amount,
          userCommandHash: withdrawalId,
        });
        shadowBurnRef = res.shadowBurnRef;
      }
    } catch (err) {
      if (err instanceof InsufficientAvailableError) {
        record = this.set(record, WithdrawalState.RejectedInsufficientAvailable);
        throw new WithdrawalRejected("rejected_insufficient_available");
      }
      this.set(record, WithdrawalState.FailedNeedsReconcile);
      throw err;
    }

    record = { ...record, shadowBurnRef, state: WithdrawalState.ShadowBurned };
    this.store.putWithdrawal(record);

    // --- ensure destination escrow liquidity (rebalance public funds only) ---
    // Drives a provider route if the destination chain is short. Never mints
    // shadow USDC and never touches game balances (spec section 7).
    const liquidity = await this.liquidity.ensureDestinationLiquidity({
      withdrawalId,
      destinationChainId: command.destinationChainId,
      destinationBridge: command.destinationBridge,
      amount: command.amount,
    });
    record = {
      ...record,
      rebalanceStatus: liquidity.status,
      rebalanceRef: liquidity.rebalanceRef,
    };
    if (!isFundedStatus(liquidity.status)) {
      // Destination not yet fundable: persist the pending/failed state and
      // return WITHOUT signing. The caller re-submits to advance the rebalance.
      const pendingState = rebalanceToWithdrawalState(liquidity.status);
      record = this.set(record, pendingState);
      return { withdrawalId, status: pendingState, shadowBurnRef, rebalance: liquidity };
    }
    if (liquidity.status === "destination_funded") {
      record = this.set(record, WithdrawalState.DestinationFunded);
    }

    // --- signing-service authorization, only now that funds are payable (7.4) ---
    let authorization: { payload: WithdrawalAuthorization; signature: Hex };
    try {
      const issued = await this.signingService.signWithdrawal(
        command,
        signature,
        shadowBurnRef,
        now,
      );
      authorization = { payload: issued.payload, signature: issued.signature };
    } catch (err) {
      if (err instanceof SignWithdrawalRejection) {
        this.set(record, WithdrawalState.FailedNeedsReconcile);
      }
      throw err;
    }

    record = {
      ...record,
      state: WithdrawalState.ServiceSigned,
      authorizationSignature: authorization.signature,
      authorizationDeadline: authorization.payload.deadline,
    };
    this.store.putWithdrawal(record);

    return {
      withdrawalId,
      status: WithdrawalState.ServiceSigned,
      shadowBurnRef,
      rebalance: liquidity,
      authorization,
    };
  }

  private set(record: WithdrawalRecord, state: WithdrawalState): WithdrawalRecord {
    const next = { ...record, state };
    this.store.putWithdrawal(next);
    return next;
  }

  private rebuildAuthorization(
    record: WithdrawalRecord,
  ): { payload: WithdrawalAuthorization; signature: Hex } {
    return {
      payload: {
        gameId: record.gameId,
        owner: record.owner,
        shadowAccount: record.shadowAccount,
        amount: record.amount,
        recipient: record.recipient,
        destinationChainId: record.destinationChainId,
        destinationBridge: record.destinationBridge,
        userCommandHash: record.withdrawalId,
        shadowBurnRef: record.shadowBurnRef!,
        nonce: record.nonce,
        deadline: record.authorizationDeadline!,
      },
      signature: record.authorizationSignature!,
    };
  }
}

/** Terminal rejection of a withdrawal command, carrying a status string. */
export class WithdrawalRejected extends Error {
  constructor(readonly status: string) {
    super(`withdrawal rejected: ${status}`);
    this.name = "WithdrawalRejected";
  }
}
