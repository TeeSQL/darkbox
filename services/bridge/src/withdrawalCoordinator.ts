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
  authorization?: { payload: WithdrawalAuthorization; signature: Hex };
}

/**
 * Drives a user withdrawal command through the withdrawal state machine (spec
 * 7.1): validate -> forced shadow burn of available balance -> signing-service
 * authorization. The public `withdraw(...)` submission is performed by the
 * user/client, not here.
 */
export class WithdrawalCoordinator {
  constructor(
    private readonly cfg: WithdrawalCoordinatorConfig,
    private readonly store: BridgeStore,
    private readonly burner: ShadowBurnSubmitter,
    private readonly signingService: SigningService,
  ) {}

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
      asset: command.asset,
      amount: command.amount,
      recipient: command.recipient,
      nonce: command.nonce,
      deadline: command.deadline,
      userSignature: signature,
      state: WithdrawalState.UserSigned,
      retries: 0,
    };
    this.store.putWithdrawal(record);

    // --- forced shadow burn of available balance (spec 7.3) ---
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
          asset: command.asset,
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

    record = {
      ...record,
      shadowBurnRef,
      state: WithdrawalState.ShadowBurned,
    };
    this.store.putWithdrawal(record);

    // --- signing-service authorization (spec 7.4) ---
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
        asset: record.asset,
        amount: record.amount,
        recipient: record.recipient,
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
