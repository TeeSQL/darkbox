import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DepositIntentState,
  DepositState,
  NATIVE_ASSET,
  deriveShadowAccount,
} from "@darkbox/shared";
import type { Address, Hex } from "viem";
import { DepositCoordinator } from "../src/depositCoordinator.js";
import { InMemoryBridgeStore } from "../src/store.js";
import { normalizeDepositEvent, type RawDepositEvent } from "../src/watcher.js";
import type { DepositIntent } from "../src/types.js";
import { FakeShadowChain } from "./fakes.js";

const GAME_ID: Hex = `0x${"11".repeat(32)}`;
const USDC: Address = "0x00000000000000000000000000000000000000c0";
const BRIDGE: Address = "0x00000000000000000000000000000000000000aa";
const ALICE: Address = "0x00000000000000000000000000000000000000b0";
const ctx = { chainId: 8453, bridgeAddress: BRIDGE };

function erc20Transfer(overrides: Partial<RawDepositEvent> = {}): RawDepositEvent {
  return {
    kind: "erc20_transfer",
    asset: USDC,
    from: ALICE,
    amount: 100_000_000n,
    txHash: `0x${"ab".repeat(32)}`,
    logIndex: 0,
    confirmations: 3,
    ...(overrides as object),
  } as RawDepositEvent;
}

function setup() {
  const store = new InMemoryBridgeStore();
  const shadow = new FakeShadowChain();
  const coord = new DepositCoordinator(
    { gameId: GAME_ID, confirmationsRequired: 3 },
    store,
    shadow,
  );
  return { store, shadow, coord };
}

test("normalizes an ERC20 transfer into a canonical observation with idempotency key", () => {
  const obs = normalizeDepositEvent(ctx, erc20Transfer());
  assert.equal(obs.asset, USDC);
  assert.equal(obs.beneficiary, ALICE); // defaults to sender
  assert.match(obs.depositOpId, /^0x[0-9a-f]{64}$/);
});

test("native receive normalizes to asset address(0) crediting the sender", () => {
  const obs = normalizeDepositEvent(ctx, {
    kind: "native_receive",
    from: ALICE,
    amount: 1_000_000_000_000_000_000n,
    txHash: `0x${"cd".repeat(32)}`,
    logIndex: 1,
    confirmations: 5,
  });
  assert.equal(obs.asset, NATIVE_ASSET);
  assert.equal(obs.beneficiary, ALICE);
});

test("confirmed deposit auto-maps the shadow account and mints once", async () => {
  const { store, shadow, coord } = setup();
  const obs = normalizeDepositEvent(ctx, erc20Transfer());

  const record = await coord.process(obs, Math.floor(Date.UTC(2026, 0, 1) / 1000));
  assert.equal(record.state, DepositState.ShadowMinted);

  const expectedShadow = deriveShadowAccount(GAME_ID, ALICE);
  assert.equal(record.shadowAccount, expectedShadow);
  assert.equal(store.getMappingByOwner(ALICE)?.shadowAccount, expectedShadow);
  assert.equal(shadow.balances.get(`${expectedShadow}:${USDC}`.toLowerCase()), 100_000_000n);
});

test("duplicate observation of the same operation mints exactly once", async () => {
  const { shadow, coord } = setup();
  const obs = normalizeDepositEvent(ctx, erc20Transfer());
  await coord.process(obs, 1000);
  await coord.process(obs, 1000); // replay
  assert.equal(shadow.mints.size, 1);
});

test("crash between mint tx and DB write recovers via findExistingMint (no double mint)", async () => {
  const { store, shadow, coord } = setup();
  const obs = normalizeDepositEvent(ctx, erc20Transfer());

  // Simulate: mint landed on-chain but the DB never recorded ShadowMinted.
  await shadow.mintShadow({
    depositOpId: obs.depositOpId,
    owner: ALICE,
    shadowAccount: deriveShadowAccount(GAME_ID, ALICE),
    asset: USDC,
    amount: obs.amount,
  });
  assert.equal(shadow.mints.size, 1);

  const record = await coord.process(obs, 1000);
  assert.equal(record.state, DepositState.ShadowMinted);
  assert.equal(shadow.mints.size, 1); // recovered, not re-minted
});

test("a deposit below the confirmation threshold is not minted", async () => {
  const { shadow, coord } = setup();
  const obs = normalizeDepositEvent(ctx, erc20Transfer({ confirmations: 1 }));
  const record = await coord.process(obs, 1000);
  assert.equal(record.state, DepositState.ObservedPublicDeposit);
  assert.equal(shadow.mints.size, 0);
});

test("a matching deposit intent re-routes the beneficiary (FIFO)", async () => {
  const { store, shadow, coord } = setup();
  const BENE: Address = "0x00000000000000000000000000000000000000e0";
  const intent: DepositIntent = {
    intentId: `0x${"01".repeat(32)}`,
    beneficiary: BENE,
    asset: USDC,
    minAmount: 50_000_000n,
    expiresAt: 2000,
    createdAt: 100,
    state: DepositIntentState.Open,
  };
  store.putIntent(intent);

  const obs = normalizeDepositEvent(ctx, erc20Transfer());
  const record = await coord.process(obs, 1500);

  assert.equal(record.owner, BENE);
  assert.equal(store.getIntent(intent.intentId)?.state, DepositIntentState.Matched);
  const shadowAccount = deriveShadowAccount(GAME_ID, BENE);
  assert.equal(shadow.balances.get(`${shadowAccount}:${USDC}`.toLowerCase()), 100_000_000n);
});

test("an expired intent does not match; the sender is credited", async () => {
  const { store, coord } = setup();
  const BENE: Address = "0x00000000000000000000000000000000000000e0";
  store.putIntent({
    intentId: `0x${"02".repeat(32)}`,
    beneficiary: BENE,
    asset: USDC,
    minAmount: 50_000_000n,
    expiresAt: 1000,
    createdAt: 100,
    state: DepositIntentState.Open,
  });
  const obs = normalizeDepositEvent(ctx, erc20Transfer());
  const record = await coord.process(obs, 1500); // observed after expiry
  assert.equal(record.owner, ALICE); // fell back to sender
});

test("an intent with too-small amount does not match", async () => {
  const { store, coord } = setup();
  const BENE: Address = "0x00000000000000000000000000000000000000e0";
  store.putIntent({
    intentId: `0x${"03".repeat(32)}`,
    beneficiary: BENE,
    asset: USDC,
    minAmount: 200_000_000n, // higher than the 100 USDC transfer
    expiresAt: 5000,
    createdAt: 100,
    state: DepositIntentState.Open,
  });
  const obs = normalizeDepositEvent(ctx, erc20Transfer());
  const record = await coord.process(obs, 1500);
  assert.equal(record.owner, ALICE);
});
