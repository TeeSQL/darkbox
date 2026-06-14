import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import {
  HttpDecisionSource,
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
const EXISTING_TX: Hex = `0x${"44".repeat(32)}`;

function intent(overrides: Partial<PendingResolution> = {}): PendingResolution {
  return {
    marketId: MARKET_ID,
    marketAddress: MARKET_ADDR,
    intentType: "resolveMarket",
    outcome: "Yes",
    ...overrides,
  };
}

/**
 * Fake resolver: records resolve calls; configurable existing-tx (idempotency)
 * and revert. `existingTx` mirrors the on-chain MarketResolved/MarketVoided log
 * lookup — non-null means a settlement tx already exists.
 */
class FakeResolver implements MarketResolver {
  resolveCalls: PendingResolution[] = [];
  existingTx: Hex | null = null;
  revert: Error | null = null;

  async resolveMarket(i: PendingResolution): Promise<ResolveResult> {
    this.resolveCalls.push(i);
    if (this.revert) throw this.revert;
    return { txHash: TX_HASH };
  }
  async findExistingResolutionTx(): Promise<Hex | null> {
    return this.existingTx;
  }
}

/**
 * Fake decision source: records markResolved calls and serves a queue. There is
 * no markFailed — #22 has no failure route; a failure simply leaves the market
 * pending (i.e. nothing is written back).
 */
class FakeSource implements DecisionSource {
  pending: PendingResolution[] = [];
  resolved: Array<{ marketId: string; txHash: Hex }> = [];

  async getPendingResolutions(): Promise<PendingResolution[]> {
    return this.pending;
  }
  async markResolved(marketId: string, info: { txHash: Hex }): Promise<void> {
    this.resolved.push({ marketId, txHash: info.txHash });
  }
}

function baseDeps(resolver: MarketResolver, source: DecisionSource): ExecutorDeps {
  return { resolver, source, log: () => {} };
}

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

// --- (a) resolve -> settlement write-back with a REAL 32-byte tx -----------

test("(a) explicit Yes resolveMarket → resolved on-chain → markResolved(real txHash)", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  const result = await processResolution(intent({ outcome: "Yes" }), baseDeps(resolver, source));

  assert.equal(result, "resolved");
  assert.equal(resolver.resolveCalls.length, 1);
  assert.equal(resolver.resolveCalls[0]!.outcome, "Yes");
  assert.equal(source.resolved.length, 1);
  assert.equal(source.resolved[0]!.marketId, MARKET_ID);
  assert.equal(source.resolved[0]!.txHash, TX_HASH);
  assert.match(source.resolved[0]!.txHash, TX_HASH_RE, "write-back must be a 32-byte hash");
});

test("voidMarket(Invalid) is executed and the real tx is written back", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  const result = await processResolution(
    intent({ intentType: "voidMarket", outcome: "Invalid" }),
    baseDeps(resolver, source),
  );

  assert.equal(result, "resolved");
  assert.equal(resolver.resolveCalls.length, 1);
  assert.equal(source.resolved[0]!.txHash, TX_HASH);
  assert.match(source.resolved[0]!.txHash, TX_HASH_RE);
});

// --- (b) idempotent skip posts the EXISTING real tx (never null) ----------

test("(b) already resolved on-chain → no new tx, markResolved(EXISTING real tx)", async () => {
  const resolver = new FakeResolver();
  resolver.existingTx = EXISTING_TX;
  const source = new FakeSource();

  const result = await processResolution(intent(), baseDeps(resolver, source));

  assert.equal(result, "already-resolved");
  assert.equal(resolver.resolveCalls.length, 0, "must NOT send a second resolution tx");
  assert.equal(source.resolved.length, 1);
  assert.equal(source.resolved[0]!.txHash, EXISTING_TX, "posts the existing tx, not null");
  assert.match(source.resolved[0]!.txHash, TX_HASH_RE);
});

// --- (c) error → no write-back, market left pending (no failure route) ----

test("(c) resolver revert → no markResolved; market left in resolution_pending", async () => {
  const resolver = new FakeResolver();
  resolver.revert = new Error("execution reverted: NotResolver");
  const source = new FakeSource();

  const result = await processResolution(intent(), baseDeps(resolver, source));

  assert.equal(result, "failed");
  assert.equal(source.resolved.length, 0, "no write-back on revert → stays resolution_pending");
});

test("runOnce processes every pending item; a failed item just stays pending", async () => {
  const source = new FakeSource();
  source.pending = [
    intent({ marketId: `0x${"a1".repeat(32)}`, outcome: "Yes" }),
    intent({ marketId: `0x${"b2".repeat(32)}`, outcome: "No" }),
  ];
  // First resolve reverts, second succeeds — simulate one bad item.
  const resolver = new FakeResolver();
  let calls = 0;
  resolver.resolveMarket = (async (_i: PendingResolution): Promise<ResolveResult> => {
    calls += 1;
    if (calls === 1) throw new Error("execution reverted: BadStatus");
    return { txHash: TX_HASH };
  }) as MarketResolver["resolveMarket"];

  const processed = await runOnce(baseDeps(resolver, source));

  assert.equal(processed, 2, "both items attempted");
  assert.equal(source.resolved.length, 1, "only the successful item is written back");
  assert.equal(source.resolved[0]!.marketId, `0x${"b2".repeat(32)}`);
});

// --- (d) invalid/ambiguous outcome -> skipped, never resolved, left pending

test("(d) ambiguous outcome (null) → SKIPPED, never resolved, never written back", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  const result = await processResolution(
    intent({ intentType: "resolveMarket", outcome: null }),
    baseDeps(resolver, source),
  );

  assert.equal(result, "skipped");
  assert.equal(resolver.resolveCalls.length, 0, "must NEVER resolve an ambiguous outcome");
  assert.equal(source.resolved.length, 0, "must NEVER write back → stays resolution_pending");
});

test("(d2) resolveMarket carrying Invalid is rejected (no resolve, no default)", async () => {
  const resolver = new FakeResolver();
  const source = new FakeSource();

  // An Invalid outcome on a resolveMarket intent is a type mismatch — it must
  // NOT be silently routed to a void; it is skipped and left pending.
  const result = await processResolution(
    intent({ intentType: "resolveMarket", outcome: "Invalid" }),
    baseDeps(resolver, source),
  );

  assert.equal(result, "skipped");
  assert.equal(resolver.resolveCalls.length, 0);
  assert.equal(source.resolved.length, 0);
});

// --- safety gate (pure) ---------------------------------------------------

test("validateIntent enforces outcome ↔ intentType pairing", () => {
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: "Yes" })).ok, true);
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: "No" })).ok, true);
  assert.equal(validateIntent(intent({ intentType: "voidMarket", outcome: "Invalid" })).ok, true);
  // mismatches
  assert.equal(validateIntent(intent({ intentType: "voidMarket", outcome: "Yes" })).ok, false);
  assert.equal(validateIntent(intent({ intentType: "voidMarket", outcome: null })).ok, false);
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: null })).ok, false);
  assert.equal(validateIntent(intent({ intentType: "resolveMarket", outcome: "Invalid" })).ok, false);
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

test("mapActionRowToIntent maps a #22 prepare_resolution row; unknown intent → dropped", () => {
  const ok = mapActionRowToIntent({
    market_id: MARKET_ID,
    market_address: MARKET_ADDR,
    action_type: "prepare_resolution",
    onchain_intent: { type: "resolveMarket", outcome: "Yes", marketAddress: MARKET_ADDR },
  });
  assert.deepEqual(ok, {
    marketId: MARKET_ID,
    marketAddress: MARKET_ADDR,
    intentType: "resolveMarket",
    outcome: "Yes",
  });

  // Known intent + ambiguous outcome is KEPT (outcome=null) so it is skipped + left pending.
  const ambiguous = mapActionRowToIntent({
    market_id: MARKET_ID,
    market_address: MARKET_ADDR,
    onchain_intent: { type: "resolveMarket", outcome: "huh" },
  });
  assert.equal(ambiguous?.outcome, null);

  // closeMarket is NOT a settlement intent → dropped entirely (bug 4).
  assert.equal(
    mapActionRowToIntent({ market_id: MARKET_ID, onchain_intent: { type: "closeMarket" } }),
    null,
  );
  // Unknown intent type → dropped.
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

// --- HTTP wiring against the real #22 contract ----------------------------

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    return handler(u, init);
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = orig;
  }
}

test("getPendingResolutions sources ONLY resolution_pending markets via /markets + lifecycle-actions", async () => {
  const PENDING = "0x" + "11".repeat(32);
  const ACTIVE = "0x" + "22".repeat(32);
  const RESOLVED = "0x" + "33".repeat(32);

  const { result: pending, calls } = await withFetch(
    (u) => {
      if (u.endsWith("/internal/markets")) {
        return jsonResponse([
          { market_id: PENDING, market_address: MARKET_ADDR, lifecycle_status: "resolution_pending" },
          { market_id: ACTIVE, market_address: MARKET_ADDR, lifecycle_status: "active" },
          { market_id: RESOLVED, market_address: MARKET_ADDR, lifecycle_status: "resolved" },
        ]);
      }
      if (u.includes(`/markets/${PENDING}/lifecycle-actions`)) {
        // newest first: a complete_resolution (none here) then prepare_resolution
        return jsonResponse([
          {
            market_id: PENDING,
            action_type: "prepare_resolution",
            onchain_intent: { type: "resolveMarket", outcome: "Yes", marketAddress: MARKET_ADDR },
          },
        ]);
      }
      return jsonResponse([]);
    },
    async () => {
      const src = new HttpDecisionSource({ internalUrl: "http://idx/internal", actorId: "t" });
      return src.getPendingResolutions();
    },
  );

  assert.equal(pending.length, 1, "only the resolution_pending market is sourced");
  assert.equal(pending[0]!.marketId, PENDING);
  assert.equal(pending[0]!.intentType, "resolveMarket");
  assert.equal(pending[0]!.outcome, "Yes");
  // non-pending markets must NOT be probed for actions.
  assert.ok(calls.some((c) => c.includes(`/markets/${PENDING}/lifecycle-actions`)));
  assert.ok(!calls.some((c) => c.includes(`/markets/${ACTIVE}/lifecycle-actions`)));
  assert.ok(!calls.some((c) => c.includes(`/markets/${RESOLVED}/lifecycle-actions`)));
});

test("markResolved POSTs a real 32-byte txHash with actorRole ocean_operator", async () => {
  let body: Record<string, unknown> | undefined;
  const { calls } = await withFetch(
    (_u, init) => {
      body = JSON.parse(String(init!.body));
      return jsonResponse({ status: "resolved" });
    },
    async () => {
      const src = new HttpDecisionSource({ internalUrl: "http://idx/internal", actorId: "act-1" });
      await src.markResolved(MARKET_ID, { txHash: TX_HASH });
    },
  );

  assert.ok(calls.some((c) => c.endsWith(`/markets/${MARKET_ID}/complete-resolution`)));
  assert.equal(body!["actorId"], "act-1");
  assert.equal(body!["actorRole"], "ocean_operator");
  assert.match(String(body!["txHash"]), TX_HASH_RE);
});

test("markResolved refuses a non-32-byte hash and never POSTs (no null write-back)", async () => {
  const { calls } = await withFetch(
    () => jsonResponse({ status: "resolved" }),
    async () => {
      const src = new HttpDecisionSource({ internalUrl: "http://idx/internal", actorId: "act-1" });
      await assert.rejects(
        () => src.markResolved(MARKET_ID, { txHash: null as unknown as Hex }),
        /32-byte tx hash/,
      );
    },
  );
  assert.equal(calls.length, 0, "must not POST when the hash is invalid");
});
