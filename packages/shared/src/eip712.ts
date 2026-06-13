import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

/**
 * EIP-712 domain shared by `WithdrawCommand` (user-signed) and
 * `WithdrawalAuthorization` (signing-service-signed). Spec section 7.2.
 *
 * The public bridge contract and public chain id are bound by the domain
 * (`verifyingContract` / `chainId`) rather than struct fields.
 */
export const EIP712_DOMAIN_NAME = "DarkBoxBridge" as const;
export const EIP712_DOMAIN_VERSION = "1" as const;

export interface BridgeDomainParams {
  /** Public escrow chain id (e.g. Base = 8453). */
  chainId: number;
  /** Public bridge contract address. */
  verifyingContract: Address;
}

export function bridgeDomain(params: BridgeDomainParams): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: params.chainId,
    verifyingContract: params.verifyingContract,
  };
}

/**
 * Canonical typed struct signed by the user (spec section 7.2).
 * USDC-only MVP: the settlement asset is fixed by the bridge, so there is no
 * `asset` field — the amount is denominated in the configured USDC.
 */
export const WITHDRAW_COMMAND_TYPES = {
  WithdrawCommand: [
    { name: "gameId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "shadowAccount", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "destinationChainId", type: "uint256" },
    { name: "destinationBridge", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "shadowChainId", type: "uint256" },
  ],
} as const;

/** Canonical typed struct signed by the signing service (spec section 7.5). */
export const WITHDRAWAL_AUTHORIZATION_TYPES = {
  WithdrawalAuthorization: [
    { name: "gameId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "shadowAccount", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "destinationChainId", type: "uint256" },
    { name: "destinationBridge", type: "address" },
    { name: "userCommandHash", type: "bytes32" },
    { name: "shadowBurnRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface WithdrawCommand {
  gameId: Hex;
  owner: Address;
  shadowAccount: Hex;
  amount: bigint;
  recipient: Address;
  destinationChainId: bigint;
  destinationBridge: Address;
  nonce: bigint;
  deadline: bigint;
  shadowChainId: bigint;
}

export interface WithdrawalAuthorization {
  gameId: Hex;
  owner: Address;
  shadowAccount: Hex;
  amount: bigint;
  recipient: Address;
  destinationChainId: bigint;
  destinationBridge: Address;
  userCommandHash: Hex;
  shadowBurnRef: Hex;
  nonce: bigint;
  deadline: bigint;
}

/**
 * `userCommandHash` = EIP-712 digest of the user's `WithdrawCommand`.
 * Also serves as `withdrawalId`, the idempotency key across the shadow burn,
 * the signing service, and the public withdrawal (spec section 1.1 / 7.2).
 */
export function hashWithdrawCommand(
  domain: BridgeDomainParams,
  command: WithdrawCommand,
): Hex {
  return hashTypedData({
    domain: bridgeDomain(domain),
    types: WITHDRAW_COMMAND_TYPES,
    primaryType: "WithdrawCommand",
    message: command,
  });
}

export function hashWithdrawalAuthorization(
  domain: BridgeDomainParams,
  auth: WithdrawalAuthorization,
): Hex {
  return hashTypedData({
    domain: bridgeDomain(domain),
    types: WITHDRAWAL_AUTHORIZATION_TYPES,
    primaryType: "WithdrawalAuthorization",
    message: auth,
  });
}

/** Recovers the signer of a `WithdrawCommand` for command validation. */
export async function recoverWithdrawCommandSigner(
  domain: BridgeDomainParams,
  command: WithdrawCommand,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: bridgeDomain(domain),
    types: WITHDRAW_COMMAND_TYPES,
    primaryType: "WithdrawCommand",
    message: command,
    signature,
  });
}

export async function recoverWithdrawalAuthorizationSigner(
  domain: BridgeDomainParams,
  auth: WithdrawalAuthorization,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: bridgeDomain(domain),
    types: WITHDRAWAL_AUTHORIZATION_TYPES,
    primaryType: "WithdrawalAuthorization",
    message: auth,
    signature,
  });
}
