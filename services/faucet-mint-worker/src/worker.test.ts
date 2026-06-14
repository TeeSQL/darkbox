import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FaucetCoordinator,
  InMemoryBridgeStore,
  type ShadowMintSubmitter,
} from "@darkbox/bridge";
import { FaucetMintState } from "@darkbox/shared";
import type { Address, Hex } from "viem";
import { runOnce } from "./worker.js";
import { serializeRecord } from "./server.js";

const GAME_ID: Hex = `0x${"11".repeat(32)}`;
const AMOUNT = 5_000_000n; // $5 at 6 decimals
const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const OWNER2: Address = "0x00000000000000000000000000000000000000a2";
const SHADOW: Hex = `0x${"22".repeat(32)}`;
const SHADOW2: Hex = `0x${"33".repeat(32)}`;
const DAEMON_ADDR: Address = "0x00000000000000000000000000000000000000d1";
const MINT_TX: Hex = `0x${"ab".repeat(32)}`;
const RECOVERED_TX: Hex = `0x${"cd".repeat(32)}`;

/** Fake controller minter: records calls, can recover via findExistingMint or fail. */
class FakeMinter implements ShadowMintSubmitter {
  mintCalls: Array<{ depositOpId: Hex; owner: Address; shadowAccount: Hex; amount: bigint }> = [];
  findCalls: Hex[] = [];
  /** operationId → tx already on-chain (idempotency recovery). */
  existing = new Map<string, Hex>();
  /** operationIds whose mintShadow should throw (simulate a revert). */
  failOn = new Set<string>();

  async mintShadow(p: {
    depositOpId: Hex;
    owner: Address;
    shadowAccount: Hex;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    this.mintCalls.push(p);
    if (this.failOn.has(p.depositOpId.toLowerCase())) {
      throw new Error("execution reverted: mint failed");
    }
    return { txHash: MINT_TX };
  }

  async findExistingMint(depositOpId: Hex): Promise<Hex | null> {
    this.findCalls.push(depositOpId);
    return this.existing.get(depositOpId.toLowerCase()) ?? null;
  }
}

function setup() {
  const store = new InMemoryBridgeStore();
  const minter = new FakeMinter();
  const coordinator = new FaucetCoordinator({ gameId: GAME_ID, amount: AMOUNT }, store, minter);
  return { store, minter, coordinator };
}

test("(a) pending grant → mintShadow → record marked minted with tx hash", async () => {
  const { store, minter, coordinator } = setup();
  const enq = coordinator.enqueueHumanPromo({
    telegramId: "tg-1",
    inviteId: "inv-1",
    owner: OWNER,
    shadowAccount: SHADOW,
  });
  assert.equal(enq.state, FaucetMintState.Pending);

  const result = await runOnce({ coordinator, log: () => {} });

  assert.deepEqual(result, { processed: 1, minted: 1, failed: 0 });
  assert.equal(minter.mintCalls.length, 1, "exactly one on-chain mint");
  const call = minter.mintCalls[0]!;
  assert.equal(call.depositOpId, enq.operationId, "mint keyed by operationId");
  assert.equal(call.owner, OWNER);
  assert.equal(call.shadowAccount, SHADOW);
  assert.equal(call.amount, AMOUNT);

  const rec = store.getFaucetMint(enq.operationId)!;
  assert.equal(rec.state, FaucetMintState.Minted);
  assert.equal(rec.txHash, MINT_TX);
  assert.ok(rec.mintedAt);
});

test("(b) idempotent recover: findExistingMint hits → NO new mint tx, marked minted", async () => {
  const { store, minter, coordinator } = setup();
  const enq = coordinator.enqueueDaemonFunding({
    daemonId: "daemon-1",
    daemonAddress: DAEMON_ADDR,
    shadowAccount: SHADOW,
  });
  // Pretend this operation was already minted on a prior (crashed) run.
  minter.existing.set(enq.operationId.toLowerCase(), RECOVERED_TX);

  const result = await runOnce({ coordinator, log: () => {} });

  assert.deepEqual(result, { processed: 1, minted: 1, failed: 0 });
  assert.equal(minter.mintCalls.length, 0, "must NOT submit a second mint");
  assert.equal(minter.findCalls.length, 1, "checked for an existing mint");
  const rec = store.getFaucetMint(enq.operationId)!;
  assert.equal(rec.state, FaucetMintState.Minted);
  assert.equal(rec.txHash, RECOVERED_TX, "recovered the existing tx hash");
});

test("(c) per-record error → marked failed, loop continues to next record", async () => {
  const { store, minter, coordinator } = setup();
  const bad = coordinator.enqueueHumanPromo({
    telegramId: "tg-bad",
    inviteId: "inv-bad",
    owner: OWNER,
    shadowAccount: SHADOW,
  });
  const good = coordinator.enqueueHumanPromo({
    telegramId: "tg-good",
    inviteId: "inv-good",
    owner: OWNER2,
    shadowAccount: SHADOW2,
  });
  minter.failOn.add(bad.operationId.toLowerCase());

  // runOnce must resolve (never throw) even though one record reverts.
  const result = await runOnce({ coordinator, log: () => {} });

  assert.equal(result.processed, 2, "both records attempted");
  assert.equal(result.failed, 1);
  assert.equal(result.minted, 1);

  const badRec = store.getFaucetMint(bad.operationId)!;
  assert.equal(badRec.state, FaucetMintState.Failed);
  assert.match(badRec.error ?? "", /reverted/);

  const goodRec = store.getFaucetMint(good.operationId)!;
  assert.equal(goodRec.state, FaucetMintState.Minted);
  assert.equal(goodRec.txHash, MINT_TX);
});

test("ENFORCE one mint per human telegram id (deterministic operationId dedup)", async () => {
  const { coordinator } = setup();
  const first = coordinator.enqueueHumanPromo({
    telegramId: "tg-dup",
    inviteId: "inv-a",
    owner: OWNER,
    shadowAccount: SHADOW,
  });
  const second = coordinator.enqueueHumanPromo({
    telegramId: "tg-dup",
    inviteId: "inv-b", // different invite, same human
    owner: OWNER2,
    shadowAccount: SHADOW2,
  });
  assert.equal(second.operationId, first.operationId, "same telegram id → same operation id");
  assert.equal(coordinator.listPending().length, 1, "only one queued grant for the human");
});

test("ENFORCE one mint per daemon (deterministic operationId dedup)", async () => {
  const { coordinator } = setup();
  const first = coordinator.enqueueDaemonFunding({
    daemonId: "daemon-dup",
    daemonAddress: DAEMON_ADDR,
    shadowAccount: SHADOW,
  });
  const second = coordinator.enqueueDaemonFunding({
    daemonId: "daemon-dup",
    daemonAddress: DAEMON_ADDR,
    shadowAccount: SHADOW,
  });
  assert.equal(second.operationId, first.operationId, "same daemon → same operation id");
  assert.equal(coordinator.listPending().length, 1, "only one queued grant for the daemon");
});

test("already-minted record is a no-op on re-process (no double mint)", async () => {
  const { minter, coordinator } = setup();
  const enq = coordinator.enqueueHumanPromo({
    telegramId: "tg-once",
    inviteId: "inv-once",
    owner: OWNER,
    shadowAccount: SHADOW,
  });
  await runOnce({ coordinator, log: () => {} });
  assert.equal(minter.mintCalls.length, 1);

  // Re-process the same operation explicitly: must short-circuit, no second mint.
  const again = await coordinator.process(enq.operationId);
  assert.equal(again.state, FaucetMintState.Minted);
  assert.equal(minter.mintCalls.length, 1, "no second on-chain mint");
});

test("serializeRecord renders the bigint amount as a decimal string (JSON-safe)", () => {
  const { coordinator } = setup();
  const rec = coordinator.enqueueHumanPromo({
    telegramId: "tg-ser",
    inviteId: "inv-ser",
    owner: OWNER,
    shadowAccount: SHADOW,
  });
  const json = serializeRecord(rec);
  assert.equal(json.amount, "5000000");
  assert.equal(typeof json.amount, "string");
});
