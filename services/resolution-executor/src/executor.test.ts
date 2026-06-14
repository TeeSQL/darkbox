import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import {
  mapActionRowToIntent,
  normalizeOutcome,
  type DecisionSource,
} from "./decisionSource.js";
import {
  processResolution,
  runOnce,
  validateIntent,
  type ExecutorDeps,
} from "./executor.js";
import type { MarketResolver, ResolveResult } from "./resolver.js";
import type { PendingResolution } from "./types.js";

const MARKET_ID: Hex = `0x${"22".repeat(32)}`;
const MARKET_ADDR: Address = "0x00000000000000000000000000000000000000a1";
const TX_HASH: Hex = `0x${"33".repeat(32)}`;

function intent(overrides: Partial<PendingResolution> = {}): PendingResolution {
  return {
    marketId: MARKET_ID,
    marketAddress: MARKET_ADDR,
    intentType: "resolveMarket",
    outcome: "Yes",
    ...overrides,
  };
}

/** Fake resolver: records resolve calls; configurable idempotency + revert. */
class FakeResolver implements MarketResolver {
  resolveCalls: PendingResolution[] = [];
  alreadyResolved = false;
  revert: Error | null = null;

  async resolveMarket(i: PendingResolution): Promise<ResolveResult> {
    this.resolveCalls.push(i);
    if (this.revert) throw this.revert;
    return { txHash: TX_HASH };
  }
  async isAlreadyResolved(): Promise<boolean> {
    return this.alreadyResolved;
  }
}

/** Fake decision source: records resolved/failed calls and serves a queue. */
class FakeSource implements DecisionSource {
  pending: PendingResolution[] = [];
  resolved: Array<{ marketId: string; txHash: Hex | null }> = [];
  failed: Array<{ marketId: string; error: string }> = [];

  async getPendingResolutions(): Promise<PendingResolution[]> {
    return this.pending;
  }
  async markResolved(marketId: string, info: { txHash: Hex | null }): Promise<void> {
    this.resolved.push({ marketId, txHash: info.txHash });
  }
  async markFailed(marketId: string, error: string): Promise<void> {
    this.failed.push({ marketId, error });
  }
}

function baseDeps(resolver: MarketResolver, source: DecisionSource): ExecutorDeps {
  return { resolver, source, log: () => {} };
}

// --- (a) resolve -> marked -----------------------------------------------

test("(a) explicit Yes resolveMarket → resolved on-chain → markResolved(txHash)", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  const result = await processResolution(intent({ outcome: "Yes" }), baseDeps(resolver, source));

  assert.equal(result, "resolved");
  assert.equal(resolver.resolveCalls.length, 1);
  assert.equal(resolver.resolveCalls[0]!.outcome, "Yes");
  assert.equal(source.resolved.length, 1);
  assert.equal(source.resolved[0]!.marketId, MARKET_ID);
  assert.equal(source.resolved[0]!.txHash, TX_HASH);
  assert.equal(source.failed.length, 0);
});

test("voidMarket(Invalid) is executed and marked resolved", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  const result = await processResolution(
    intent({ intentType: "voidMarket", outcome: "Invalid" }),
    baseDeps(resolver, source),
  );

  assert.equal(result, "resolved");
  assert.equal(resolver.resolveCalls.length, 1);
  assert.equal(source.resolved[0]!.txHash, TX_HASH);
});

// --- (b) idempotent skip --------------------------------------------------

test("(b) already resolved on-chain → no tx sent, markResolved(null)", async () => {
  const resolver = new FakeResolver();
  resolver.alreadyResolved = true;
  const source = new FakeSource();

  const result = await processResolution(intent(), baseDeps(resolver, source));

  assert.equal(result, "already-resolved");
  assert.equal(resolver.resolveCalls.length, 0, "must NOT send a second resolution tx");
  assert.equal(source.resolved.length, 1);
  assert.equal(source.resolved[0]!.txHash, null);
  assert.equal(source.failed.length, 0);
});

// --- (c) error -> failed, loop continues ---------------------------------

test("(c) resolver revert → markFailed, no markResolved", async () => {
  const resolver = new FakeResolver();
  resolver.revert = new Error("execution reverted: NotResolver");
  const source = new FakeSource();

  const result = await processResolution(intent(), baseDeps(resolver, source));

  assert.equal(result, "failed");
  assert.equal(source.resolved.length, 0, "no resolve write-back on revert");
  assert.equal(source.failed.length, 1);
  assert.equal(source.failed[0]!.marketId, MARKET_ID);
  assert.match(source.failed[0]!.error, /NotResolver/);
});

test("runOnce processes every pending item and contains per-item failures", async () => {
  const source = new FakeSource();
  source.pending = [
    intent({ marketId: `0x${"a1".repeat(32)}`, outcome: "Yes" }),
    intent({ marketId: `0x${"b2".repeat(32)}`, outcome: "No" }),
  ];
  // First resolve reverts, second succeeds — simulate one bad item.
  const resolver = new FakeResolver();
  let calls = 0;
  resolver.resolveMarket = (async (i: PendingResolution): Promise<ResolveResult> => {
    calls += 1;
    if (calls === 1) throw new Error("execution reverted: BadStatus");
    return { txHash: TX_HASH };
  }) as MarketResolver["resolveMarket"];

  const processed = await runOnce(baseDeps(resolver, source));

  assert.equal(processed, 2, "both items attempted");
  assert.equal(source.failed.length, 1);
  assert.equal(source.failed[0]!.marketId, `0x${"a1".repeat(32)}`);
  assert.equal(source.resolved.length, 1);
  assert.equal(source.resolved[0]!.marketId, `0x${"b2".repeat(32)}`);
});

// --- (d) invalid/ambiguous outcome -> skipped, never resolved ------------

test("(d) ambiguous outcome (null) → SKIPPED + flagged, never resolved", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  const result = await processResolution(
    intent({ intentType: "resolveMarket", outcome: null }),
    baseDeps(resolver, source),
  );

  assert.equal(result, "skipped");
  assert.equal(resolver.resolveCalls.length, 0, "must NEVER resolve an ambiguous outcome");
  assert.equal(source.resolved.length, 0, "must NEVER mark resolved");
  assert.equal(source.failed.length, 1, "flagged for a human");
  assert.match(source.failed[0]!.error, /explicit Yes\/No/);
});

test("(d2) resolveMarket carrying Invalid is rejected (no resolve, no default)", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  // An Invalid outcome on a resolveMarket intent is a type mismatch — it must
  // NOT be silently routed to a void; it is skipped + flagged.
  const result = await processResolution(
    intent({ intentType: "resolveMarket", outcome: "Invalid" }),
    baseDeps(resolver, source),
  );

  assert.equal(result, "skipped");
  assert.equal(resolver.resolveCalls.length, 0);
  assert.equal(source.resolved.length, 0);
  assert.equal(source.failed.length, 1);
});

// --- pure helpers ---------------------------------------------------------

test("validateIntent enforces outcome ↔ intentType pairing", () => {
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: "Yes" })).ok, true);
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: "No" })).ok, true);
  assert.equal(validateIntent(intent({ intentType: "voidMarket", outcome: "Invalid" })).ok, true);
  assert.equal(validateIntent(intent({ intentType: "closeMarket", outcome: null })).ok, true);
  // mismatches
  assert.equal(validateIntent(intent({ intentType: "voidMarket", outcome: "Yes" })).ok, false);
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: null })).ok, false);
  assert.equal(validateIntent(intent({ intentType: "closeMarket", outcome: "Yes" })).ok, false);
});

test("normalizeOutcome maps known labels and rejects junk", () => {
  assert.equal(normalizeOutcome("Yes"), "Yes");
  assert.equal(normalizeOutcome("no"), "No");
  assert.equal(normalizeOutcome("INVALID"), "Invalid");
  assert.equal(normalizeOutcome("void"), "Invalid");
  assert.equal(normalizeOutcome("maybe"), null);
  assert.equal(normalizeOutcome(undefined), null);
  assert.equal(normalizeOutcome(42), null);
});

test("mapActionRowToIntent maps a #22 row; unknown intent type → dropped", () => {
  const ok = mapActionRowToIntent({
    market_id: MARKET_ID,
    market_address: MARKET_ADDR,
    action_type: "prepare_resolution",
    onchain_intent: { type: "resolveMarket", outcome: "Yes" },
  });
  assert.deepEqual(ok, {
    marketId: MARKET_ID,
    marketAddress: MARKET_ADDR,
    intentType: "resolveMarket",
    outcome: "Yes",
  });

  // Known intent + ambiguous outcome is KEPT (outcome=null) so it is skipped + flagged.
  const ambiguous = mapActionRowToIntent({
    market_id: MARKET_ID,
    market_address: MARKET_ADDR,
    onchain_intent: { type: "resolveMarket", outcome: "huh" },
  });
  assert.equal(ambiguous?.outcome, null);

  // Unknown intent type → dropped entirely.
  assert.equal(
    mapActionRowToIntent({ market_id: MARKET_ID, onchain_intent: { type: "nonsense" } }),
    null,
  );
  // Missing address → dropped.
  assert.equal(
    mapActionRowToIntent({ market_id: MARKET_ID, onchain_intent: { type: "resolveMarket" } }),
    null,
  );
});
