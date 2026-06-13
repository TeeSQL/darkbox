/**
 * Withdrawal signing core (spec 7.4/7.5 "Signing Service Contract").
 *
 * This is the security-critical verifier that signs a `WithdrawalAuthorization`
 * ONLY after every mandatory check passes. It is dependency-injected so the
 * actual key, burn verification, nonce source, and liquidity check are supplied
 * by the host. It belongs in the ISOLATED `darkbox-signer` service (the key must
 * never sit in the bridge) — it lives in `@darkbox/shared` so the signer service
 * and any verifier reuse one battle-tested implementation.
 */
import {
  bridgeDomain,
  hashWithdrawCommand,
  recoverWithdrawCommandSigner,
  WITHDRAWAL_AUTHORIZATION_TYPES,
  type BridgeDomainParams,
} from "./eip712.js";
import type { WithdrawalAuthorization, WithdrawCommand } from "./eip712.js";
import { getAddress, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

/** Verifies a confirmed shadow burn on the shadow chain (check 3). */
export interface ShadowBurnVerifier {
  hasConfirmedBurn(params: { withdrawalId: Hex; shadowBurnRef: Hex; amount: bigint }): Promise<boolean>;
}

/** Reads used-nonce state from the public bridge contract (check 4). */
export interface NonceChecker {
  isNonceUsed(owner: Address, nonce: bigint): Promise<boolean>;
}

/** Confirms the destination escrow can pay before we authorize (check 5). */
export interface DestinationFundingChecker {
  isDestinationFunded(params: {
    withdrawalId: Hex;
    destinationChainId: bigint;
    destinationBridge: Address;
    amount: bigint;
  }): Promise<boolean>;
}

/** Always-funded default (used when no escrow check is wired). */
export const allowAllDestinationFunding: DestinationFundingChecker = {
  async isDestinationFunded() {
    return true;
  },
};

/** Typed-data signer with exclusive access to the signer key (a viem LocalAccount). */
export type TypedDataSigner = Pick<LocalAccount, "address" | "signTypedData">;

export interface IssuedAuthorization {
  withdrawalId: Hex;
  payload: WithdrawalAuthorization;
  signature: Hex;
}

/** Persists issued authorizations to enforce the re-issue invariant (7.5). */
export interface AuthorizationStore {
  get(withdrawalId: Hex): IssuedAuthorization | undefined;
  put(record: IssuedAuthorization): void;
}

export class InMemoryAuthorizationStore implements AuthorizationStore {
  private map = new Map<Hex, IssuedAuthorization>();
  get(withdrawalId: Hex): IssuedAuthorization | undefined {
    return this.map.get(withdrawalId);
  }
  put(record: IssuedAuthorization): void {
    this.map.set(record.withdrawalId, record);
  }
}

export type SignWithdrawalError =
  | "bad_user_signature"
  | "wrong_owner"
  | "mapping_mismatch"
  | "burn_not_confirmed"
  | "nonce_used"
  | "destination_liquidity_unavailable"
  | "reissue_parameter_mismatch";

export class SignWithdrawalRejection extends Error {
  constructor(readonly reason: SignWithdrawalError) {
    super(`signing service rejected: ${reason}`);
    this.name = "SignWithdrawalRejection";
  }
}

export interface SigningServiceConfig {
  domain: BridgeDomainParams;
  /** Authorization validity window in seconds (default 24h). */
  authTtlSeconds?: number;
  resolveShadowAccount: (command: WithdrawCommand) => Hex;
}

export interface SigningServiceDeps {
  signer: TypedDataSigner;
  burnVerifier: ShadowBurnVerifier;
  nonceChecker: NonceChecker;
  authStore: AuthorizationStore;
  fundingChecker?: DestinationFundingChecker;
}

/**
 * Stateless verifier with exclusive access to the withdrawal signer key. It
 * signs ONLY a `WithdrawalAuthorization`, and only after every mandatory check
 * passes. Identical re-issue with a fresh deadline is permitted (7.5).
 */
export class SigningService {
  constructor(
    private readonly cfg: SigningServiceConfig,
    private readonly deps: SigningServiceDeps,
  ) {}

  async signWithdrawal(
    command: WithdrawCommand,
    userSignature: Hex,
    shadowBurnRef: Hex,
    now: number,
  ): Promise<IssuedAuthorization> {
    // (1) user signature recovers to owner over the canonical digest
    let recovered: Address;
    try {
      recovered = await recoverWithdrawCommandSigner(this.cfg.domain, command, userSignature);
    } catch {
      throw new SignWithdrawalRejection("bad_user_signature");
    }
    if (getAddress(recovered) !== getAddress(command.owner)) {
      throw new SignWithdrawalRejection("wrong_owner");
    }

    // (2) owner <-> shadowAccount mapping matches canonical derivation/registry
    const expectedShadow = this.cfg.resolveShadowAccount(command);
    if (expectedShadow.toLowerCase() !== command.shadowAccount.toLowerCase()) {
      throw new SignWithdrawalRejection("mapping_mismatch");
    }

    const withdrawalId = hashWithdrawCommand(this.cfg.domain, command);

    // (3) confirmed shadow burn with matching withdrawalId/amount
    const burnOk = await this.deps.burnVerifier.hasConfirmedBurn({
      withdrawalId,
      shadowBurnRef,
      amount: command.amount,
    });
    if (!burnOk) throw new SignWithdrawalRejection("burn_not_confirmed");

    // (4) nonce unused on the public bridge contract
    if (await this.deps.nonceChecker.isNonceUsed(command.owner, command.nonce)) {
      throw new SignWithdrawalRejection("nonce_used");
    }

    // (5) destination escrow must be confirmed fundable before we sign
    const fundingChecker = this.deps.fundingChecker ?? allowAllDestinationFunding;
    const funded = await fundingChecker.isDestinationFunded({
      withdrawalId,
      destinationChainId: command.destinationChainId,
      destinationBridge: command.destinationBridge,
      amount: command.amount,
    });
    if (!funded) throw new SignWithdrawalRejection("destination_liquidity_unavailable");

    // (6) no prior authorization for this withdrawalId with different params
    const prior = this.deps.authStore.get(withdrawalId);
    if (prior && !sameCoreParams(prior.payload, command, shadowBurnRef)) {
      throw new SignWithdrawalRejection("reissue_parameter_mismatch");
    }

    const ttl = this.cfg.authTtlSeconds ?? 24 * 60 * 60;
    const payload: WithdrawalAuthorization = {
      gameId: command.gameId,
      owner: command.owner,
      shadowAccount: command.shadowAccount,
      amount: command.amount,
      recipient: command.recipient,
      destinationChainId: command.destinationChainId,
      destinationBridge: command.destinationBridge,
      userCommandHash: withdrawalId,
      shadowBurnRef,
      nonce: command.nonce,
      deadline: BigInt(now + ttl),
    };

    const signature = await this.deps.signer.signTypedData({
      domain: bridgeDomain(this.cfg.domain),
      types: WITHDRAWAL_AUTHORIZATION_TYPES,
      primaryType: "WithdrawalAuthorization",
      message: payload,
    });

    const issued: IssuedAuthorization = { withdrawalId, payload, signature };
    this.deps.authStore.put(issued);
    return issued;
  }
}

/** Core params that must stay identical across a re-issue (deadline may change). */
function sameCoreParams(
  prior: WithdrawalAuthorization,
  command: WithdrawCommand,
  shadowBurnRef: Hex,
): boolean {
  return (
    prior.gameId.toLowerCase() === command.gameId.toLowerCase() &&
    getAddress(prior.owner) === getAddress(command.owner) &&
    prior.shadowAccount.toLowerCase() === command.shadowAccount.toLowerCase() &&
    prior.amount === command.amount &&
    getAddress(prior.recipient) === getAddress(command.recipient) &&
    prior.destinationChainId === command.destinationChainId &&
    getAddress(prior.destinationBridge) === getAddress(command.destinationBridge) &&
    prior.nonce === command.nonce &&
    prior.shadowBurnRef.toLowerCase() === shadowBurnRef.toLowerCase()
  );
}
