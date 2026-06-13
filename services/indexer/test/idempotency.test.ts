import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockDb } from "./helpers/mockDb.js";
import { storeEvent } from "../src/ingestion/processor.js";
import { makeDepositReceivedEvent } from "./fixtures/events.js";

describe("event idempotency (storeEvent)", () => {
  it("stores an event and returns a non-null id", async () => {
    const db = new MockDb();
    const event = makeDepositReceivedEvent();
    const id = await storeEvent(db.client as never, event);
    assert.notEqual(id, null, "first insert should return an id");
  });

  it("returns null for a duplicate chainId+txHash+logIndex", async () => {
    const db = new MockDb();
    const event = makeDepositReceivedEvent();
    const first = await storeEvent(db.client as never, event);
    assert.notEqual(first, null);
    const second = await storeEvent(db.client as never, event);
    assert.equal(second, null, "duplicate event must be rejected");
  });

  it("stores two events with different logIndex independently", async () => {
    const db = new MockDb();
    const event1 = makeDepositReceivedEvent({ logIndex: 0 });
    const event2 = makeDepositReceivedEvent({ logIndex: 1 });
    const id1 = await storeEvent(db.client as never, event1);
    const id2 = await storeEvent(db.client as never, event2);
    assert.notEqual(id1, null);
    assert.notEqual(id2, null);
    assert.notEqual(id1, id2);
  });

  it("stores two events with different txHash independently", async () => {
    const db = new MockDb();
    const txA = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const txB = ("0x" + "bb".repeat(32)) as `0x${string}`;
    const id1 = await storeEvent(db.client as never, makeDepositReceivedEvent({ txHash: txA }));
    const id2 = await storeEvent(db.client as never, makeDepositReceivedEvent({ txHash: txB }));
    assert.notEqual(id1, null);
    assert.notEqual(id2, null);
  });
});
