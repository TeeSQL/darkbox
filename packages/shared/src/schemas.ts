import { z } from "zod";

/** 0x-hex string of arbitrary length (signatures, refs). */
export const hexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex");

/** 20-byte address. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte address");

/** 32-byte hash. */
export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hash");

/** uint256 carried as a base-10 string over the wire (JSON-safe). */
export const uint256Schema = z
  .string()
  .regex(/^[0-9]+$/, "must be a base-10 unsigned integer string");

/** Wire form of a `WithdrawCommand` (uint256 fields as decimal strings). */
export const withdrawCommandSchema = z.object({
  gameId: bytes32Schema,
  owner: addressSchema,
  shadowAccount: bytes32Schema,
  amount: uint256Schema,
  recipient: addressSchema,
  destinationChainId: uint256Schema,
  destinationBridge: addressSchema,
  nonce: uint256Schema,
  deadline: uint256Schema,
  shadowChainId: uint256Schema,
});
export type WithdrawCommandWire = z.infer<typeof withdrawCommandSchema>;

/** Wire form of a `WithdrawalAuthorization`. */
export const withdrawalAuthorizationSchema = z.object({
  gameId: bytes32Schema,
  owner: addressSchema,
  shadowAccount: bytes32Schema,
  amount: uint256Schema,
  recipient: addressSchema,
  destinationChainId: uint256Schema,
  destinationBridge: addressSchema,
  userCommandHash: bytes32Schema,
  shadowBurnRef: bytes32Schema,
  nonce: uint256Schema,
  deadline: uint256Schema,
});
export type WithdrawalAuthorizationWire = z.infer<typeof withdrawalAuthorizationSchema>;

/** `POST /api/withdrawals/commands` request body (spec section 11). */
export const submitWithdrawalRequestSchema = z.object({
  command: withdrawCommandSchema,
  signature: hexSchema,
});
export type SubmitWithdrawalRequest = z.infer<typeof submitWithdrawalRequestSchema>;

/** `POST /api/withdrawals/commands` response body. */
export const submitWithdrawalResponseSchema = z.object({
  withdrawalId: bytes32Schema,
  status: z.string(),
  shadowBurnRef: bytes32Schema.optional(),
  authorization: z
    .object({
      payload: withdrawalAuthorizationSchema,
      signature: hexSchema,
    })
    .optional(),
});
export type SubmitWithdrawalResponse = z.infer<typeof submitWithdrawalResponseSchema>;

/** `POST /api/deposit-intents` request (spec section 6.5). USDC-only: no asset. */
export const createDepositIntentSchema = z.object({
  beneficiary: addressSchema,
  minAmount: uint256Schema,
  expectedFrom: addressSchema.optional(),
  expiresAt: z.number().int().positive(),
});
export type CreateDepositIntentRequest = z.infer<typeof createDepositIntentSchema>;

/** `POST /internal/signing-service/sign-withdrawal` request (spec section 7.4). */
export const signWithdrawalRequestSchema = z.object({
  command: withdrawCommandSchema,
  signature: hexSchema,
  shadowBurnRef: bytes32Schema,
});
export type SignWithdrawalRequest = z.infer<typeof signWithdrawalRequestSchema>;
