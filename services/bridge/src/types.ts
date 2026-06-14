import type { Address, Hex } from "viem";
import type {
  DepositIntentState,
  DepositState,
  FaucetMintState,
  WithdrawalState,
} from "@darkbox/shared";

/** A normalized public deposit observation from any watcher source. */
export interface DepositObservation {
  /** keccak256 of the canonical operation string (spec 6.4); idempotency key. */
  depositOpId: Hex;
  /** Human-readable canonical operation string (stored for audit). */
  operationString: string;
  chainId: number;
  amount: bigint;
  from: Address;
  /** Beneficiary owner (defaults to `from`, may be re-routed by an intent). */
  beneficiary: Address;
  txHash: Hex;
  logIndex: number;
  /** Confirmations observed at detection time. */
  confirmations: number;
}

/** Persisted deposit record tracked through the deposit state machine. */
export interface DepositRecord {
  depositOpId: Hex;
  operationString: string;
  amount: bigint;
  from: Address;
  beneficiary: Address;
  owner: Address;
  shadowAccount: Hex;
  txHash: Hex;
  logIndex: number;
  state: DepositState;
  shadowMintTxHash?: Hex;
  retries: number;
}

/** Owner <-> shadow account mapping mirror (spec 5.1). */
export interface AccountMapping {
  owner: Address;
  shadowAccount: Hex;
}

/** Deposit intent (spec 6.5). */
export interface DepositIntent {
  intentId: Hex;
  beneficiary: Address;
  minAmount: bigint;
  expectedFrom?: Address;
  expiresAt: number;
  createdAt: number;
  state: DepositIntentState;
  matchedDepositOpId?: Hex;
}

/** Persisted withdrawal record tracked through the withdrawal state machine. */
export interface WithdrawalRecord {
  /** withdrawalId == userCommandHash (spec 1.1). */
  withdrawalId: Hex;
  gameId: Hex;
  owner: Address;
  shadowAccount: Hex;
  amount: bigint;
  recipient: Address;
  destinationChainId: bigint;
  destinationBridge: Address;
  rebalanceStatus?: "not_needed" | "required" | "route_selected" | "source_transfer_submitted" | "destination_funded" | "failed_needs_operator_reconcile";
  rebalanceRef?: Hex;
  nonce: bigint;
  deadline: bigint;
  userSignature: Hex;
  state: WithdrawalState;
  shadowBurnRef?: Hex;
  authorizationSignature?: Hex;
  authorizationDeadline?: bigint;
  retries: number;
}

export type FaucetMintKind = "human_promo" | "daemon_funding";

export interface FaucetMintRecord {
  /** Deterministic idempotency key used as the shadow mint operation id. */
  operationId: Hex;
  operationString: string;
  kind: FaucetMintKind;
  gameId: Hex;
  amount: bigint;
  owner: Address;
  shadowAccount: Hex;
  state: FaucetMintState;
  txHash?: Hex;
  mintedAt?: string;
  error?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  telegramId?: string;
  inviteId?: string;
  daemonId?: string;
  daemonAddress?: Address;
}
