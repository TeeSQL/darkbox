import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  bridgeDomain,
  hashWithdrawCommand,
  hashWithdrawalAuthorization,
  recoverWithdrawCommandSigner,
  WITHDRAW_COMMAND_TYPES,
  type BridgeDomainParams,
  type WithdrawCommand,
  type WithdrawalAuthorization,
} from "../src/eip712.js";

const domain: BridgeDomainParams = {
  chainId: 8453,
  verifyingContract: "0x00000000000000000000000000000000000000aa",
};

const command: WithdrawCommand = {
  gameId: `0x${"11".repeat(32)}`,
  owner: "0x00000000000000000000000000000000000000b0",
  shadowAccount: `0x${"22".repeat(32)}`,
  amount: 1_000_000n,
  recipient: "0x00000000000000000000000000000000000000d0",
  nonce: 7n,
  deadline: 1_893_456_000n,
  shadowChainId: 1337n,
};

const auth: WithdrawalAuthorization = {
  gameId: command.gameId,
  owner: command.owner,
  shadowAccount: command.shadowAccount,
  amount: command.amount,
  recipient: command.recipient,
  userCommandHash: `0x${"33".repeat(32)}`,
  shadowBurnRef: `0x${"44".repeat(32)}`,
  nonce: command.nonce,
  deadline: command.deadline,
};

// These constants are also asserted in the Foundry EIP712Parity test, proving
// the TS (viem) and Solidity encodings are byte-identical (USDC-only: no asset).
test("WithdrawCommand digest matches the cross-language reference", () => {
  assert.equal(
    hashWithdrawCommand(domain, command),
    "0xfe50710d78078e6226bf9d45a1bdbd18fc2e58fd8afbc2d26b1425648a85f860",
  );
});

test("WithdrawalAuthorization digest matches the cross-language reference", () => {
  assert.equal(
    hashWithdrawalAuthorization(domain, auth),
    "0x0f090d5e98ad8babae1e03d33e03cd92ae734309735ebd69dca89628887f38b1",
  );
});

test("a user-signed command recovers to the owner", async () => {
  const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
  const cmd = { ...command, owner: account.address };
  const signature = await account.signTypedData({
    domain: bridgeDomain(domain),
    types: WITHDRAW_COMMAND_TYPES,
    primaryType: "WithdrawCommand",
    message: cmd,
  });
  const recovered = await recoverWithdrawCommandSigner(domain, cmd, signature);
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});
