import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroAddress, type Address, type Hex } from "viem";
import type { CreateMarketInput, CreatedMarket, FactoryClient } from "./factory.js";
import type { DeployedResult, IndexerClient, ProposalRow } from "./indexerClient.js";
import {
  buildCreateMarketInput,
  processProposal,
  runOnce,
  RESOLVER_TYPE_ADMIN_MANUAL,
  type ExecutorDeps,
} from "./executor.js";

const GAME_ID: Hex = `0x${"11".repeat(32)}`;
const COORDINATOR: Address = "0x00000000000000000000000000000000000000c0";
const MARKET_ID: Hex = `0x${"22".repeat(32)}`;
const MARKET_ADDR: Address = "0x00000000000000000000000000000000000000a1";
const YES_BOOK: Address = "0x00000000000000000000000000000000000000b1";
const NO_BOOK: Address = "0x00000000000000000000000000000000000000b2";
const YES_TOKEN: Address = "0x00000000000000000000000000000000000000c1";
const NO_TOKEN: Address = "0x00000000000000000000000000000000000000c2";
const TX_HASH: Hex = `0x${"33".repeat(32)}`;

function proposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    proposal_id: "run1-agent1-3",
    agent_id: "agent1",
    question: "Will the canonical project win the hackathon?",
    description: "A test market.",
    resolution_source: "hackathon-judges",
    metadata_uri: "ipfs://darkbox/test.json",
    status: "approved",
    ...overrides,
  };
}

const FIXED_TIMES = { closeTime: 1_750_000_000n, resolveBy: 1_750_086_400n };

function baseDeps(factory: FactoryClient, indexer: IndexerClient): ExecutorDeps {
  return {
    factory,
    indexer,
    coordinatorAddress: COORDINATOR,
    gameId: GAME_ID,
    creatorBond: 0n,
    initialLiquidity: 0n,
    marketTimes: () => FIXED_TIMES,
    log: () => {}, // silence logs in tests
  };
}

/** Fake factory: records calls; configurable to return an existing market or to revert. */
class FakeFactory implements FactoryClient {
  createCalls: CreateMarketInput[] = [];
  findCalls: Array<{ gameId: Hex; question: string }> = [];
  existing: CreatedMarket | null = null;
  revert: Error | null = null;

  async createMarket(input: CreateMarketInput): Promise<CreatedMarket> {
    this.createCalls.push(input);
    if (this.revert) throw this.revert;
    return {
      txHash: TX_HASH,
      marketId: MARKET_ID,
      marketAddress: MARKET_ADDR,
      yesBook: YES_BOOK,
      noBook: NO_BOOK,
      yesToken: YES_TOKEN,
      noToken: NO_TOKEN,
    };
  }

  async findExistingMarketByQuestion(gameId: Hex, question: string): Promise<CreatedMarket | null> {
    this.findCalls.push({ gameId, question });
    return this.existing;
  }
}

/** Fake indexer: records deployed/failed calls and serves a queue of approved proposals. */
class FakeIndexer implements IndexerClient {
  approved: ProposalRow[] = [];
  deployed: Array<{ proposalId: string; result: DeployedResult }> = [];
  failed: Array<{ proposalId: string; error: string }> = [];

  async getApprovedProposals(): Promise<ProposalRow[]> {
    return this.approved;
  }
  async markDeployed(proposalId: string, result: DeployedResult): Promise<void> {
    this.deployed.push({ proposalId, result });
  }
  async markFailed(proposalId: string, error: string): Promise<void> {
    this.failed.push({ proposalId, error });
  }
}

test("buildCreateMarketInput maps proposal + config into valid CreateMarketParams", () => {
  const input = buildCreateMarketInput(proposal(), {
    coordinatorAddress: COORDINATOR,
    gameId: GAME_ID,
    creatorBond: 7n,
    initialLiquidity: 9n,
    marketTimes: () => FIXED_TIMES,
  });
  assert.equal(input.gameId, GAME_ID);
  assert.equal(input.question, "Will the canonical project win the hackathon?");
  assert.equal(input.metadataURI, "ipfs://darkbox/test.json");
  assert.equal(input.resolver.resolverType, RESOLVER_TYPE_ADMIN_MANUAL);
  assert.equal(input.resolver.resolver, COORDINATOR);
  assert.equal(input.resolver.data, "0x");
  assert.equal(input.closeTime, FIXED_TIMES.closeTime);
  assert.equal(input.resolveBy, FIXED_TIMES.resolveBy);
  assert.equal(input.creatorBond, 7n);
  assert.equal(input.initialLiquidity, 9n);
});

test("buildCreateMarketInput falls back to a deterministic metadataURI when empty", () => {
  const input = buildCreateMarketInput(proposal({ metadata_uri: "" }), {
    coordinatorAddress: COORDINATOR,
    gameId: GAME_ID,
    creatorBond: 0n,
    initialLiquidity: 0n,
    marketTimes: () => FIXED_TIMES,
  });
  assert.equal(input.metadataURI, "darkbox:proposal:run1-agent1-3");
});

test("(a) approved proposal → createMarket with right params → markDeployed with parsed results", async () => {
  const factory = new FakeFactory();
  const indexer = new FakeIndexer();
  const deps = baseDeps(factory, indexer);

  const result = await processProposal(proposal(), deps);

  assert.ok(result, "expected a created market");
  // createMarket was called exactly once with the proposal's data.
  assert.equal(factory.createCalls.length, 1);
  const call = factory.createCalls[0]!;
  assert.equal(call.gameId, GAME_ID);
  assert.equal(call.question, "Will the canonical project win the hackathon?");
  assert.equal(call.resolver.resolverType, RESOLVER_TYPE_ADMIN_MANUAL);
  assert.equal(call.resolver.resolver, COORDINATOR);

  // markDeployed received the parsed on-chain results.
  assert.equal(indexer.deployed.length, 1);
  const dep = indexer.deployed[0]!;
  assert.equal(dep.proposalId, "run1-agent1-3");
  assert.equal(dep.result.marketId, MARKET_ID);
  assert.equal(dep.result.marketAddress, MARKET_ADDR);
  assert.equal(dep.result.yesBook, YES_BOOK);
  assert.equal(dep.result.noBook, NO_BOOK);
  assert.equal(dep.result.yesToken, YES_TOKEN);
  assert.equal(dep.result.noToken, NO_TOKEN);
  assert.equal(dep.result.txHash, TX_HASH);
  assert.equal(dep.result.creatorAddress, COORDINATOR);
  assert.equal(indexer.failed.length, 0);
});

test("(b) idempotency: existing market found → createMarket NOT called, but markDeployed still runs", async () => {
  const factory = new FakeFactory();
  factory.existing = {
    txHash: null, // recovery → no new tx
    marketId: MARKET_ID,
    marketAddress: MARKET_ADDR,
    yesBook: YES_BOOK,
    noBook: NO_BOOK,
    yesToken: zeroAddress,
    noToken: zeroAddress,
  };
  const indexer = new FakeIndexer();
  const deps = baseDeps(factory, indexer);

  const result = await processProposal(proposal(), deps);

  assert.ok(result);
  assert.equal(factory.findCalls.length, 1, "should have checked for an existing market");
  assert.equal(factory.createCalls.length, 0, "must NOT create a second market");
  assert.equal(indexer.deployed.length, 1, "still writes the result back");
  const dep = indexer.deployed[0]!;
  assert.equal(dep.result.marketId, MARKET_ID);
  assert.equal(dep.result.txHash, null);
  assert.equal(indexer.failed.length, 0);
});

test("(c) factory revert → markFailed, no markDeployed, loop continues", async () => {
  const factory = new FakeFactory();
  factory.revert = new Error("execution reverted: DuplicateQuestion");
  const indexer = new FakeIndexer();
  const deps = baseDeps(factory, indexer);

  const result = await processProposal(proposal(), deps);

  assert.equal(result, null, "failed proposal returns null");
  assert.equal(indexer.deployed.length, 0, "no deploy write-back on revert");
  assert.equal(indexer.failed.length, 1);
  assert.equal(indexer.failed[0]!.proposalId, "run1-agent1-3");
  assert.match(indexer.failed[0]!.error, /DuplicateQuestion/);
});

test("runOnce processes every approved proposal and contains per-proposal failures", async () => {
  const factory = new FakeFactory();
  // First call reverts, subsequent calls succeed — simulate one bad proposal.
  let calls = 0;
  factory.createMarket = (async (input: CreateMarketInput): Promise<CreatedMarket> => {
    calls += 1;
    if (calls === 1) throw new Error("execution reverted: BadTimes");
    return {
      txHash: TX_HASH,
      marketId: MARKET_ID,
      marketAddress: MARKET_ADDR,
      yesBook: YES_BOOK,
      noBook: NO_BOOK,
      yesToken: YES_TOKEN,
      noToken: NO_TOKEN,
    };
  }) as FactoryClient["createMarket"];

  const indexer = new FakeIndexer();
  indexer.approved = [
    proposal({ proposal_id: "p-bad", question: "Q one is long enough?" }),
    proposal({ proposal_id: "p-good", question: "Q two is long enough?" }),
  ];
  const deps = baseDeps(factory, indexer);

  const processed = await runOnce(deps);

  assert.equal(processed, 2, "both proposals were attempted");
  assert.equal(indexer.failed.length, 1);
  assert.equal(indexer.failed[0]!.proposalId, "p-bad");
  assert.equal(indexer.deployed.length, 1);
  assert.equal(indexer.deployed[0]!.proposalId, "p-good");
});
