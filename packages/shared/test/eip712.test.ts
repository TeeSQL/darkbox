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
  asset: "0x00000000000000000000000000000000000000c0",
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
  asset: command.asset,
  amount: command.amount,
  recipient: command.recipient,
  userCommandHash: `0x${"33".repeat(32)}`,
  shadowBurnRef: `0x${"44".repeat(32)}`,
  nonce: command.nonce,
  deadline: command.deadline,
};

// These constants are also asserted in the Foundry EIP712Parity test, proving
// the TS (viem) and Solidity encodings are byte-identical.
test("WithdrawCommand digest matches the cross-language reference", () => {
  assert.equal(
    hashWithdrawCommand(domain, command),
    "0x7f4a1fbeca3e14721fbcf6a8b09f5ae7740055e91df095246fcf55590f940767",
  );
});

test("WithdrawalAuthorization digest matches the cross-language reference", () => {
  assert.equal(
    hashWithdrawalAuthorization(domain, auth),
    "0xa9dbfe194baf4892ce0715e58cf275df00b7bc3616ccbe67b2b7d5f4518a32ec",
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
