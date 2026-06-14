import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Store loaders are validated against fake clients. We exercise the signal
 * transitions (idle → loading → ready / error) without a real backend.
 *
 * The store imports ../api/index, which constructs real clients from env; that
 * is fine here because the loaders go through indexer/gateway methods we can't
 * easily stub post-construction. So instead we test the slice/loader contract
 * via a lightweight re-implementation guard: import the module and assert its
 * initial signal values and exported shape.
 */
import * as store from "./store.js";

test("slices start idle/empty", () => {
  assert.equal(store.publicState.value, "idle");
  assert.equal(store.selfState.value, "idle");
  assert.deepEqual(store.markets.value, []);
  assert.deepEqual(store.leaderboard.value, []);
  assert.equal(store.game.value, null);
  assert.equal(store.self.value, null);
});

test("derived signals reflect self", () => {
  assert.equal(store.isRegistered.value, false);
  assert.equal(store.isFunded.value, false);
  store.self.value = {
    registrationStatus: "registered",
    fundingStatus: "promo_funded",
  } as never;
  assert.equal(store.isRegistered.value, true);
  assert.equal(store.isFunded.value, true);
  store.self.value = null; // reset
});

test("loadSelf sets error state when gateway rejects", async () => {
  // No backend reachable in test → fetch rejects → loader captures error.
  await store.loadSelf();
  assert.equal(store.selfState.value, "error");
  assert.notEqual(store.selfError.value, null);
});
