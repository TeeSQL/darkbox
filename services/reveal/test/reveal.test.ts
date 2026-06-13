import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRevealBundle, reconcileAccounting } from "../src/bundle.js";
import { buildTimeline } from "../src/timeline.js";
import type { RevealMeta, RevealSources } from "../src/types.js";

function fakeSources(over: Partial<Record<keyof RevealSources, unknown>> = {}): RevealSources {
  const base: RevealSources = {
    getDeployments: async () => ({ "darkbox-private-88813": { darkbox: "0xabc" } }),
    getMarkets: async () => [{ marketId: "m1", question: "Will X win?", status: "resolved", outcome: "YES" }],
    getOrders: async () => [{ marketId: "m1", agentId: "a1", side: "YES", price: "0.6", size: "10" }],
    getFills: async () => [{ marketId: "m1", takerAgentId: "a2", price: "0.6", size: "5", fee: "0.01" }],
    getPositions: async () => [{ marketId: "m1", agentId: "a1", outcome: "YES", size: "5" }],
    getLeaderboard: async () => [{ agentId: "a1", ensName: "raven.darkbox.eth", pnl: "12.4", rank: 1 }],
    getAgents: async () => [
      { agentId: "a1", instructionHash: "0xhash", revealedInstruction: "Buy NO on wrappers" },
    ],
    getRawEvents: async () => [
      { t: 21, type: "leaderboard_update" },
      { t: 6, type: "market_created", marketId: "m1" },
      { t: 14, type: "trade", agentId: "a2", marketId: "m1" },
    ],
    getAccounting: async () => ({
      publicDepositedUsdc: "100.000000",
      shadowMintedUsdc: "115.000000",
      promoCreditedUsdc: "15.000000",
      withdrawnUsdc: "0.000000",
      feesAccruedUsdc: "0.010000",
    }),
  };
  return { ...base, ...(over as Partial<RevealSources>) };
}

const meta = (includeInstructions: boolean): RevealMeta => ({
  gameId: "0x0000000000000000000000000000000000000000000000000000000000000001",
  title: "DarkBox",
  builtAt: "2026-06-13T16:00:00.000Z",
  revealPolicy: { includeInstructions },
});

test("accounting reconciles when shadowMinted == deposited + promo", () => {
  const a = reconcileAccounting({
    publicDepositedUsdc: "100.000000",
    shadowMintedUsdc: "115.000000",
    promoCreditedUsdc: "15.000000",
    withdrawnUsdc: "0.000000",
    feesAccruedUsdc: "0.000000",
  });
  assert.equal(a.reconciled, true);
  assert.equal(a.discrepancyUsdc, "0.000000");
});

test("accounting flags a mint/backing discrepancy", () => {
  const a = reconcileAccounting({
    publicDepositedUsdc: "100.000000",
    shadowMintedUsdc: "120.000000",
    promoCreditedUsdc: "15.000000",
    withdrawnUsdc: "0.000000",
    feesAccruedUsdc: "0.000000",
  });
  assert.equal(a.reconciled, false);
  assert.equal(a.discrepancyUsdc, "5.000000");
});

test("timeline is sorted by t and gets a reveal_opened beat", () => {
  const tl = buildTimeline(
    [
      { t: 21, type: "leaderboard_update" },
      { t: 6, type: "market_created" },
    ],
    99,
  );
  assert.deepEqual(tl.map((e) => e.t), [6, 21, 99]);
  assert.equal(tl[tl.length - 1]?.type, "reveal_opened");
});

test("bundle includes the strategy preimage only when policy allows", async () => {
  const withInstr = await buildRevealBundle(fakeSources(), meta(true));
  assert.equal(withInstr.agents[0]?.revealedInstruction, "Buy NO on wrappers");

  const without = await buildRevealBundle(fakeSources(), meta(false));
  assert.equal(without.agents[0]?.revealedInstruction, undefined);
  assert.equal(without.agents[0]?.instructionHash, "0xhash", "hash still present");
});

test("bundle is reconciled, hashed, and deterministic", async () => {
  const b1 = await buildRevealBundle(fakeSources(), meta(false));
  const b2 = await buildRevealBundle(fakeSources(), meta(false));
  assert.equal(b1.accounting.reconciled, true);
  assert.match(b1.integrity.bundleHash, /^0x[0-9a-f]{64}$/);
  assert.equal(b1.integrity.bundleHash, b2.integrity.bundleHash, "same inputs => same hash");
  assert.equal(b1.markets.length, 1);
  assert.ok(b1.integrity.eventCount >= 3);
});
