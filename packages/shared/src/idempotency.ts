import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

export const NATIVE_ASSET: Address = "0x0000000000000000000000000000000000000000";

/**
 * Canonical fields that uniquely identify a single public deposit operation
 * (spec section 6.4):
 *
 *   chainId:bridgeAddress:asset:txHash:logIndex:from:beneficiary:amount
 */
export interface DepositOperationKey {
  chainId: number;
  bridgeAddress: Address;
  asset: Address;
  txHash: Hex;
  logIndex: number;
  from: Address;
  beneficiary: Address;
  amount: bigint;
}

/** The canonical deposit operation string (lowercased addresses for stability). */
export function depositOperationString(key: DepositOperationKey): string {
  return [
    key.chainId,
    key.bridgeAddress.toLowerCase(),
    key.asset.toLowerCase(),
    key.txHash.toLowerCase(),
    key.logIndex,
    key.from.toLowerCase(),
    key.beneficiary.toLowerCase(),
    key.amount.toString(),
  ].join(":");
}

/**
 * The onchain `depositOpId` passed to `mintShadow(...)`: keccak256 of the
 * canonical deposit operation string. Deterministic and idempotent: the same
 * operation always yields the same id, so a duplicate observation never mints
 * twice (spec section 6.4).
 */
export function depositOpId(key: DepositOperationKey): Hex {
  return keccak256(stringToHex(depositOperationString(key)));
}

/**
 * Deterministic shadow account derivation (spec section 1.1):
 *   shadowAccount = keccak256(abi.encode(gameId, owner))
 */
export function deriveShadowAccount(gameId: Hex, owner: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "gameId", type: "bytes32" },
        { name: "owner", type: "address" },
      ],
      [gameId, owner],
    ),
  );
}
