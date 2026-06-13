import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockDb } from "./helpers/mockDb.js";
import {
  makeAgentRegisteredEvent,
  makeDepositReceivedEvent,
  makeWithdrawalExecutedEvent,
  makeShadowMintedEvent,
  makeMarketCreatedEvent,
} from "./fixtures/events.js";
import { applyBridgeEvent, applyShadowBridgeEvent } from "../src/reducers/bridge.js";
import { applyPmFactoryEvent } from "../src/reducers/pm.js";

describe("bridge reducer", () => {
  it("stores an agent on AgentRegistered", async () => {
    const db = new MockDb();
    const event = makeAgentRegisteredEvent();
    await applyBridgeEvent(db.client as never, event);

    const agents = db.getTable("agents");
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!["ens_name"], "alice.eth");
    assert.equal(agents[0]!["shadow_account"], "0xshadow000000000000000000000000000000001");
  });

  it("is idempotent — duplicate AgentRegistered does not insert a second row", async () => {
    const db = new MockDb();
    const event = makeAgentRegisteredEvent();
    await applyBridgeEvent(db.client as never, event);
    await applyBridgeEvent(db.client as never, event);

    const agents = db.getTable("agents");
    assert.equal(agents.length, 1, "should still be 1 agent");
  });

  it("records a balance on DepositReceived", async () => {
    const db = new MockDb();
    // Register agent first so shadow account lookup works
    await applyBridgeEvent(db.client as never, makeAgentRegisteredEvent());
    const depositEvent = makeDepositReceivedEvent();
    await applyBridgeEvent(db.client as never, depositEvent);

    const queries = db.queries.filter((q) =>
      q.sql.toLowerCase().includes("insert into balances"),
    );
    assert.ok(queries.length >= 1, "should have inserted a balance row");
  });

  it("records a withdrawal on WithdrawalExecuted", async () => {
    const db = new MockDb();
    await applyBridgeEvent(db.client as never, makeAgentRegisteredEvent());
    await applyBridgeEvent(db.client as never, makeWithdrawalExecutedEvent());

    const balanceQueries = db.queries.filter((q) =>
      q.sql.toLowerCase().includes("insert into balances"),
    );
    assert.ok(balanceQueries.length >= 1, "should have a balance mutation");
  });
});

describe("shadow bridge reducer", () => {
  it("credits balance on ShadowMinted", async () => {
    const db = new MockDb();
    const event = makeShadowMintedEvent();
    await applyShadowBridgeEvent(db.client as never, event);

    const balanceInserts = db.queries.filter((q) =>
      q.sql.toLowerCase().includes("insert into balances"),
    );
    assert.ok(balanceInserts.length >= 1, "should insert a balance entry");
  });
});

describe("pm factory reducer", () => {
  it("inserts a market on MarketCreated", async () => {
    const db = new MockDb();
    const event = makeMarketCreatedEvent();
    await applyPmFactoryEvent(db.client as never, event);

    const marketInserts = db.queries.filter((q) =>
      q.sql.toLowerCase().includes("insert into markets"),
    );
    assert.ok(marketInserts.length >= 1, "should insert a market row");
  });

  it("records the question correctly", async () => {
    const db = new MockDb();
    const event = makeMarketCreatedEvent();
    await applyPmFactoryEvent(db.client as never, event);

    const insertQ = db.queries.find((q) =>
      q.sql.toLowerCase().includes("insert into markets"),
    );
    assert.ok(insertQ, "market insert query should exist");
    const values = insertQ!.values as unknown[];
    const questionIdx = values.findIndex(
      (v) => typeof v === "string" && (v as string).includes("Will ETH"),
    );
    assert.ok(questionIdx >= 0, "question should be in values");
  });
});
