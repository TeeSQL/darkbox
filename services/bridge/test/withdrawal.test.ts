import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WithdrawalState,
  bridgeDomain,
  deriveShadowAccount,
  hashWithdrawCommand,
  WITHDRAW_COMMAND_TYPES,
  type BridgeDomainParams,
  type WithdrawCommand,
} from "@darkbox/shared";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SigningService,
  InMemoryAuthorizationStore,
  SignWithdrawalRejection,
} from "../src/signingService.js";
import { InMemoryBridgeStore } from "../src/store.js";
import {
  WithdrawalCoordinator,
  WithdrawalRejected,
} from "../src/withdrawalCoordinator.js";
import { validateWithdrawCommand } from "../src/withdrawalValidator.js";
import { FakeShadowChain } from "./fakes.js";

const GAME_ID: Hex = `0x${"11".repeat(32)}`;
const USDC: Address = "0x00000000000000000000000000000000000000c0";
const BRIDGE: Address = "0x00000000000000000000000000000000000000aa";
const RECIPIENT: Address = "0x00000000000000000000000000000000000000d0";
const SHADOW_CHAIN_ID = 1337n;
const NOW = Math.floor(Date.UTC(2026, 0, 1) / 1000);

const domain: BridgeDomainParams = { chainId: 8453, verifyingContract: BRIDGE };
const userAccount = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const signerAccount = privateKeyToAccount(`0x${"cd".repeat(32)}`);

function buildCommand(overrides: Partial<WithdrawCommand> = {}): WithdrawCommand {
  const owner = userAccount.address;
  return {
    gameId: GAME_ID,
    owner,
    shadowAccount: deriveShadowAccount(GAME_ID, owner),
    amount: 40_000_000n,
    recipient: RECIPIENT,
    nonce: 1n,
    deadline: BigInt(NOW + 3600),
    shadowChainId: SHADOW_CHAIN_ID,
    ...overrides,
  };
}

async function signCommand(command: WithdrawCommand): Promise<Hex> {
  return userAccount.signTypedData({
    domain: bridgeDomain(domain),
    types: WITHDRAW_COMMAND_TYPES,
    primaryType: "WithdrawCommand",
    message: command,
  });
}

function makeCoordinator(shadow: FakeShadowChain) {
  const store = new InMemoryBridgeStore();
  const signingService = new SigningService(
    {
      domain,
      resolveShadowAccount: (c) => deriveShadowAccount(GAME_ID, c.owner),
    },
    {
      signer: signerAccount,
      burnVerifier: shadow,
      nonceChecker: shadow,
      authStore: new InMemoryAuthorizationStore(),
    },
  );
  const coord = new WithdrawalCoordinator(
    { domain, gameId: GAME_ID, shadowChainId: SHADOW_CHAIN_ID },
    store,
    shadow,
    signingService,
  );
  return { store, coord, signingService };
}

// --- validator ---

test("validates a correctly-signed command and returns the withdrawalId", async () => {
  const command = buildCommand();
  const sig = await signCommand(command);
  const res = await validateWithdrawCommand(
    { domain, gameId: GAME_ID, shadowChainId: SHADOW_CHAIN_ID, now: NOW },
    command,
    sig,
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.withdrawalId, hashWithdrawCommand(domain, command));
});

test("rejects a command signed by someone other than the owner", async () => {
  const command = buildCommand();
  const sig = await signCommand(command);
  const tampered = { ...command, owner: RECIPIENT }; // owner != signer
  const res = await validateWithdrawCommand(
    { domain, gameId: GAME_ID, shadowChainId: SHADOW_CHAIN_ID, now: NOW },
    tampered,
    sig,
  );
  assert.deepEqual(res, { ok: false, error: "wrong_owner" });
});

test("rejects an expired command", async () => {
  const command = buildCommand({ deadline: BigInt(NOW - 1) });
  const sig = await signCommand(command);
  const res = await validateWithdrawCommand(
    { domain, gameId: GAME_ID, shadowChainId: SHADOW_CHAIN_ID, now: NOW },
    command,
    sig,
  );
  assert.deepEqual(res, { ok: false, error: "expired_deadline" });
});

test("rejects a command whose shadowAccount does not match the mapping", async () => {
  const command = buildCommand({ shadowAccount: `0x${"99".repeat(32)}` });
  const sig = await signCommand(command);
  const res = await validateWithdrawCommand(
    { domain, gameId: GAME_ID, shadowChainId: SHADOW_CHAIN_ID, now: NOW },
    command,
    sig,
  );
  assert.deepEqual(res, { ok: false, error: "mapping_mismatch" });
});

// --- full coordinator happy path ---

test("full withdrawal happy path reaches service_signed with a valid authorization", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand();
  shadow.setBalance(command.shadowAccount, 100_000_000n);
  const { coord, store } = makeCoordinator(shadow);

  const sig = await signCommand(command);
  const result = await coord.submit(command, sig, NOW);

  assert.equal(result.status, WithdrawalState.ServiceSigned);
  assert.ok(result.shadowBurnRef);
  assert.ok(result.authorization);

  // burned available balance
  assert.equal(shadow.balances.get(command.shadowAccount.toLowerCase()), 60_000_000n);

  // signing service signature recovers to the signer over the authorization
  const recovered = await import("@darkbox/shared").then((m) =>
    m.recoverWithdrawalAuthorizationSigner(
      domain,
      result.authorization!.payload,
      result.authorization!.signature,
    ),
  );
  assert.equal(recovered.toLowerCase(), signerAccount.address.toLowerCase());

  // persisted as service_signed
  assert.equal(
    store.getWithdrawal(result.withdrawalId)?.state,
    WithdrawalState.ServiceSigned,
  );
});

test("withdrawal exceeding available balance is rejected as insufficient", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand({ amount: 200_000_000n });
  shadow.setBalance(command.shadowAccount, 100_000_000n);
  const { coord } = makeCoordinator(shadow);
  const sig = await signCommand(command);

  await assert.rejects(
    () => coord.submit(command, sig, NOW),
    (err: unknown) =>
      err instanceof WithdrawalRejected &&
      err.status === "rejected_insufficient_available",
  );
});

test("withdrawal against locked balance is rejected (no liquidation)", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand({ amount: 40_000_000n });
  shadow.setBalance(command.shadowAccount, 100_000_000n);
  shadow.setLocked(command.shadowAccount, 70_000_000n); // only 30 free
  const { coord } = makeCoordinator(shadow);
  const sig = await signCommand(command);

  await assert.rejects(
    () => coord.submit(command, sig, NOW),
    (err: unknown) =>
      err instanceof WithdrawalRejected &&
      err.status === "rejected_insufficient_available",
  );
});

test("resubmitting a completed command returns the existing authorization (idempotent)", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand();
  shadow.setBalance(command.shadowAccount, 100_000_000n);
  const { coord } = makeCoordinator(shadow);
  const sig = await signCommand(command);

  const first = await coord.submit(command, sig, NOW);
  const second = await coord.submit(command, sig, NOW + 10);

  assert.equal(first.withdrawalId, second.withdrawalId);
  assert.equal(second.status, WithdrawalState.ServiceSigned);
  assert.equal(shadow.burns.size, 1); // burned exactly once
});

// --- signing service guards ---

test("signing service refuses without a confirmed shadow burn", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand();
  const sig = await signCommand(command);
  const { signingService } = makeCoordinator(shadow);

  await assert.rejects(
    () => signingService.signWithdrawal(command, sig, `0x${"00".repeat(32)}`, NOW),
    (err: unknown) =>
      err instanceof SignWithdrawalRejection && err.reason === "burn_not_confirmed",
  );
});

test("signing service refuses when the nonce is already used", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand();
  const withdrawalId = hashWithdrawCommand(domain, command);
  // simulate a confirmed burn + already-used nonce
  shadow.setBalance(command.shadowAccount, 100_000_000n);
  const { shadowBurnRef } = await shadow.burnForWithdrawal({
    withdrawalId,
    owner: command.owner,
    shadowAccount: command.shadowAccount,
    amount: command.amount,
    userCommandHash: withdrawalId,
  });
  shadow.useNonce(command.owner, command.nonce);
  const sig = await signCommand(command);
  const { signingService } = makeCoordinator(shadow);

  await assert.rejects(
    () => signingService.signWithdrawal(command, sig, shadowBurnRef, NOW),
    (err: unknown) =>
      err instanceof SignWithdrawalRejection && err.reason === "nonce_used",
  );
});

test("signing service allows identical re-issue with a fresh deadline", async () => {
  const shadow = new FakeShadowChain();
  const command = buildCommand();
  shadow.setBalance(command.shadowAccount, 100_000_000n);
  const withdrawalId = hashWithdrawCommand(domain, command);
  const { shadowBurnRef } = await shadow.burnForWithdrawal({
    withdrawalId,
    owner: command.owner,
    shadowAccount: command.shadowAccount,
    amount: command.amount,
    userCommandHash: withdrawalId,
  });
  const sig = await signCommand(command);
  const { signingService } = makeCoordinator(shadow);

  const first = await signingService.signWithdrawal(command, sig, shadowBurnRef, NOW);
  const second = await signingService.signWithdrawal(
    command,
    sig,
    shadowBurnRef,
    NOW + 100_000,
  );
  assert.ok(second.payload.deadline > first.payload.deadline);
  assert.equal(first.withdrawalId, second.withdrawalId);
});
