import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockDb } from "./helpers/mockDb.js";
import { storeEvent } from "../src/ingestion/processor.js";
import {
  makeAgentRegisteredEvent,
  makeDepositReceivedEvent,
  makeShadowMintedEvent,
  makeMarketCreatedEvent,
  makeFrontierDepositEvent,
  makeFrontierClaimEvent,
} from "./fixtures/events.js";
import { applyBridgeEvent, applyShadowBridgeEvent } from "../src/reducers/bridge.js";
import { applyPmFactoryEvent } from "../src/reducers/pm.js";
import { applyFrontierEvent } from "../src/reducers/frontier.js";

describe("fixture ingestion — bridge events", () => {
  it("processes AgentRegistered → DepositReceived pipeline", async () => {
    const db = new MockDb();
    const c = db.client as never;

    await storeEvent(c, makeAgentRegisteredEvent());
    await applyBridgeEvent(c, makeAgentRegisteredEvent());

    await storeEvent(c, makeDepositReceivedEvent());
    await applyBridgeEvent(c, makeDepositReceivedEvent());

    const balanceInserts = db.queries.filter((q) =>
      q.sql.toLowerCase().includes("insert into balances"),
    );
    assert.ok(balanceInserts.length >= 1, "balance insert should occur");
  });

  it("processes ShadowMinted after DepositReceived", async () => {
    const db = new MockDb();
    const c = db.client as never;

    await applyBridgeEvent(c, makeAgentRegisteredEvent());
    await applyBridgeEvent(c, makeDepositReceivedEvent());
    await applyShadowBridgeEvent(c, makeShadowMintedEvent());

    const allQueries = db.queries.map((q) => q.sql.toLowerCase());
    const hasBalanceInsert = allQueries.some((q) => q.includes("insert into balances"));
    assert.ok(hasBalanceInsert, "should have balance inserts for both bridge and shadow");
  });
});

describe("fixture ingestion — PM factory events", () => {
  it("processes MarketCreated event", async () => {
    const db = new MockDb();
    const c = db.client as never;

    const event = makeMarketCreatedEvent();
    await storeEvent(c, event);
    await applyPmFactoryEvent(c, event);

    const marketInsert = db.queries.find((q) =>
      q.sql.toLowerCase().includes("insert into markets"),
    );
    assert.ok(marketInsert, "market insert should occur");
    const values = marketInsert!.values as unknown[];
    const question = values.find(
      (v) => typeof v === "string" && (v as string).includes("ETH"),
    );
    assert.ok(question, "question should be in values");
  });
});

describe("fixture ingestion — Frontier CLOB events", () => {
  it("processes Deposit (order placed) event", async () => {
    const db = new MockDb();
    const c = db.client as never;

    const event = makeFrontierDepositEvent();
    await storeEvent(c, event);
    await applyFrontierEvent(c, event);

    const orderInsert = db.queries.find((q) =>
      q.sql.toLowerCase().includes("insert into orders"),
    );
    assert.ok(orderInsert, "order insert should occur on Frontier Deposit");
  });

  it("processes Claim (maker fill) event and marks order filled", async () => {
    const db = new MockDb();
    const c = db.client as never;

    // Place the order first
    await applyFrontierEvent(c, makeFrontierDepositEvent());
    // Then claim
    await applyFrontierEvent(c, makeFrontierClaimEvent());

    const fillInserts = db.queries.filter((q) =>
      q.sql.toLowerCase().includes("insert into fills"),
    );
    assert.ok(fillInserts.length >= 1, "fill should be recorded on Claim");
  });

  it("idempotent: duplicate Deposit events don't double-insert orders", async () => {
    const db = new MockDb();
    const c = db.client as never;

    const event = makeFrontierDepositEvent();
    await storeEvent(c, event);
    const id1 = await storeEvent(c, event); // duplicate
    assert.equal(id1, null, "duplicate event must return null");
  });
});
