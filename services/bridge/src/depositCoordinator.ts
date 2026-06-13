import {
  DepositIntentState,
  DepositState,
  deriveShadowAccount,
} from "@darkbox/shared";
import type { Address, Hex } from "viem";
import { matchIntent } from "./intents.js";
import type { ShadowMintSubmitter } from "./shadow.js";
import type { BridgeStore } from "./store.js";
import type { DepositObservation, DepositRecord } from "./types.js";

export interface DepositCoordinatorConfig {
  gameId: Hex;
  confirmationsRequired: number;
}

/**
 * Drives a public deposit through the deposit state machine (spec 6.2/6.3):
 * confirm -> resolve beneficiary (intent match) -> resolve/create mapping ->
 * idempotent shadow mint. Safe to call repeatedly for the same observation;
 * `depositOpId` is the idempotency key throughout (spec 6.4).
 */
export class DepositCoordinator {
  constructor(
    private readonly cfg: DepositCoordinatorConfig,
    private readonly store: BridgeStore,
    private readonly minter: ShadowMintSubmitter,
  ) {}

  /**
   * Processes one observation. Returns the resulting (persisted) record.
   * @param observedAt unix seconds, used for intent expiry matching.
   */
  async process(
    observation: DepositObservation,
    observedAt: number,
  ): Promise<DepositRecord> {
    const existing = this.store.getDeposit(observation.depositOpId);
    if (existing && existing.state === DepositState.ShadowMinted) {
      return existing; // already credited; never mint twice (spec 6.4)
    }

    // Below the confirmation threshold: record as observed and wait.
    if (observation.confirmations < this.cfg.confirmationsRequired) {
      return this.upsert(existing, observation, {
        owner: observation.beneficiary,
        shadowAccount: this.resolveShadow(observation.beneficiary),
        state: DepositState.ObservedPublicDeposit,
      });
    }

    // Confirmed: resolve beneficiary, possibly re-routed by a deposit intent.
    const beneficiary = this.resolveBeneficiary(observation, observedAt);
    const owner = beneficiary;
    const shadowAccount = this.resolveShadow(owner);

    // Ensure mapping mirror (spec 5.1) exists in the bridge DB.
    if (!this.store.getMappingByOwner(owner)) {
      this.store.putMapping({ owner, shadowAccount });
    }

    let record = this.upsert(existing, observation, {
      owner,
      shadowAccount,
      beneficiary,
      state: DepositState.MappingResolved,
    });

    // Idempotent mint: recover from a prior submit before re-submitting.
    let txHash = await this.minter.findExistingMint(observation.depositOpId);
    if (!txHash) {
      record = this.transition(record, DepositState.ShadowMintSubmitted);
      const res = await this.minter.mintShadow({
        depositOpId: observation.depositOpId,
        owner,
        shadowAccount,
        amount: observation.amount,
      });
      txHash = res.txHash;
    }

    record = {
      ...record,
      shadowMintTxHash: txHash,
      state: DepositState.ShadowMinted,
    };
    this.store.putDeposit(record);
    return record;
  }

  private resolveBeneficiary(
    observation: DepositObservation,
    observedAt: number,
  ): Address {
    // Explicit deposit events already carry the intended beneficiary; only
    // ambiguous direct transfers/sends consult intents.
    const open = this.store.listOpenIntents();
    const intent = matchIntent(observation, open, observedAt);
    if (intent) {
      this.store.putIntent({
        ...intent,
        state: DepositIntentState.Matched,
        matchedDepositOpId: observation.depositOpId,
      });
      return intent.beneficiary;
    }
    return observation.beneficiary;
  }

  private resolveShadow(owner: Address): Hex {
    return (
      this.store.getMappingByOwner(owner)?.shadowAccount ??
      deriveShadowAccount(this.cfg.gameId, owner)
    );
  }

  private upsert(
    existing: DepositRecord | undefined,
    observation: DepositObservation,
    patch: Partial<DepositRecord> & {
      owner: Address;
      shadowAccount: Hex;
      state: DepositState;
    },
  ): DepositRecord {
    const record: DepositRecord = {
      depositOpId: observation.depositOpId,
      operationString: observation.operationString,
      amount: observation.amount,
      from: observation.from,
      beneficiary: patch.beneficiary ?? observation.beneficiary,
      owner: patch.owner,
      shadowAccount: patch.shadowAccount,
      txHash: observation.txHash,
      logIndex: observation.logIndex,
      state: patch.state,
      shadowMintTxHash: existing?.shadowMintTxHash,
      retries: existing?.retries ?? 0,
    };
    this.store.putDeposit(record);
    return record;
  }

  private transition(record: DepositRecord, state: DepositState): DepositRecord {
    const next = { ...record, state };
    this.store.putDeposit(next);
    return next;
  }
}
