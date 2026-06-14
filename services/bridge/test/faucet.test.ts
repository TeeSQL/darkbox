import assert from "node:assert/strict";
import { test } from "node:test";
import { FaucetMintState, humanPromoOperationId } from "@darkbox/shared";
import type { Address, Hex } from "viem";
import { FaucetConflictError, FaucetCoordinator } from "../src/faucet.js";
import { InMemoryBridgeStore } from "../src/store.js";
import { FakeShadowChain } from "./fakes.js";

const GAME_ID: Hex = `0x${"44".repeat(32)}`;
const ALICE: Address = "0x00000000000000000000000000000000000000a1";
const ALICE_SHADOW: Hex = `0x${"a1".repeat(32)}`;
const DAEMON: Address = "0x00000000000000000000000000000000000000d1";
const DAEMON_SHADOW: Hex = `0x${"d1".repeat(32)}`;

function setup() {
  const store = new InMemoryBridgeStore();
  const shadow = new FakeShadowChain();
  const coord = new FaucetCoordinator({ gameId: GAME_ID, amount: 5_000_000n }, store, shadow);
  return { store, shadow, coord };
}

test("human promo enqueue is deterministic and idempotent per Telegram id", async () => {
  const { store, shadow, coord } = setup();

  const first = coord.enqueueHumanPromo({
    telegramId: "123",
    inviteId: "invite_a",
    owner: ALICE,
    shadowAccount: ALICE_SHADOW,
    requestedAt: "2026-06-14T00:00:00.000Z",
  });
  const second = coord.enqueueHumanPromo({
    telegramId: "123",
    inviteId: "invite_b",
    owner: ALICE,
    shadowAccount: ALICE_SHADOW,
    requestedAt: "2026-06-14T00:01:00.000Z",
  });

  assert.equal(first.operationId, humanPromoOperationId({ gameId: GAME_ID, telegramId: "123" }));
  assert.equal(second.operationId, first.operationId);
  assert.equal(store.listFaucetMints().length, 1);

  const minted = await coord.processNext("2026-06-14T00:02:00.000Z");
  assert.equal(minted?.state, FaucetMintState.Minted);
  assert.equal(shadow.balances.get(ALICE_SHADOW.toLowerCase()), 5_000_000n);

  await coord.process(first.operationId, "2026-06-14T00:03:00.000Z");
  assert.equal(shadow.mints.size, 1);
});

test("daemon faucet is one allocation per daemon id/address/shadow account", async () => {
  const { shadow, coord } = setup();

  const first = coord.enqueueDaemonFunding({
    daemonId: "murmur",
    daemonAddress: DAEMON,
    shadowAccount: DAEMON_SHADOW,
    requestedAt: "2026-06-14T00:00:00.000Z",
  });
  const replay = coord.enqueueDaemonFunding({
    daemonId: "murmur",
    daemonAddress: DAEMON,
    shadowAccount: DAEMON_SHADOW,
  });
  assert.equal(replay.operationId, first.operationId);

  assert.throws(
    () =>
      coord.enqueueDaemonFunding({
        daemonId: "murmur",
        daemonAddress: "0x00000000000000000000000000000000000000d2",
        shadowAccount: DAEMON_SHADOW,
      }),
    FaucetConflictError,
  );

  const minted = await coord.process(first.operationId, "2026-06-14T00:02:00.000Z");
  assert.equal(minted.state, FaucetMintState.Minted);
  assert.equal(shadow.balances.get(DAEMON_SHADOW.toLowerCase()), 5_000_000n);

  await coord.process(first.operationId, "2026-06-14T00:03:00.000Z");
  assert.equal(shadow.mints.size, 1);
});
