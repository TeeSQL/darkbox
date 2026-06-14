import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  closeExpiredMarkets,
  closeMarket,
  defaultMarketExpiry,
  prepareResolution,
} from "../src/marketLifecycle.js";

type Row = Record<string, unknown>;

class LifecycleDb {
  markets: Row[] = [];
  actions: Row[] = [];

  get client() {
    return {
      query: (sql: string, values?: unknown[]) => this.query(sql, values ?? []),
    };
  }

  query(sql: string, values: unknown[] = []): { rows: Row[]; rowCount: number } {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.startsWith("select market_id, market_address")) {
      const market = this.markets.find((row) => row["market_id"] === values[0]);
      return { rows: market ? [market] : [], rowCount: market ? 1 : 0 };
    }

    if (normalized.startsWith("select market_id, expires_at")) {
      const now = Number(values[0]);
      const rows = this.markets.filter((row) =>
        ["active", "paused"].includes(String(row["lifecycle_status"])) &&
        Number(row["expires_at"] ?? 0) > 0 &&
        Number(row["expires_at"]) <= now,
      );
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("insert into market_lifecycle_actions")) {
      const actionId = String(values[0]);
      if (this.actions.some((row) => row["action_id"] === actionId)) {
        return { rows: [], rowCount: 0 };
      }
      this.actions.push({
        action_id: values[0],
        market_id: values[1],
        action_type: values[2],
        actor_id: values[3],
        actor_role: values[4],
        reason: values[5],
        outcome: values[6],
        evidence: values[7],
        source: values[8],
        tx_hash: values[9],
        onchain_intent: JSON.parse(String(values[10] ?? "{}")) as unknown,
        created_at_ts: values[11],
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("update markets") && normalized.includes("lifecycle_status='closed'")) {
      const market = this.markets.find((row) => row["market_id"] === values[0]);
      if (!market || !["active", "paused"].includes(String(market["lifecycle_status"]))) {
        return { rows: [], rowCount: 0 };
      }
      market["lifecycle_status"] = "closed";
      market["status"] = "Closed";
      market["closed_at"] ??= values[1];
      market["close_actor_id"] ??= values[2];
      market["close_action_id"] ??= values[3];
      return { rows: [{ market_id: values[0] }], rowCount: 1 };
    }

    if (normalized.startsWith("update markets") && normalized.includes("lifecycle_status='resolution_pending'")) {
      const market = this.markets.find((row) => row["market_id"] === values[0]);
      if (!market || !["active", "paused", "closed", "resolution_pending"].includes(String(market["lifecycle_status"]))) {
        return { rows: [], rowCount: 0 };
      }
      market["lifecycle_status"] = "resolution_pending";
      market["status"] = "Closed";
      market["closed_at"] ??= values[1];
      market["outcome"] = values[2];
      market["resolved_outcome"] = values[2];
      market["evidence"] = values[3];
      market["resolution_source"] = values[4];
      market["resolve_actor_id"] = values[5];
      market["resolve_action_id"] = values[6];
      return { rows: [{ market_id: values[0] }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe("market lifecycle expiry", () => {
  it("defaults to Sunday 5pm America/New_York before the weekly cutoff", () => {
    const expiry = defaultMarketExpiry(new Date("2026-06-14T18:00:00.000Z"));
    assert.equal(expiry.toISOString(), "2026-06-14T21:00:00.000Z");
  });

  it("moves to the next Sunday after the weekly cutoff", () => {
    const expiry = defaultMarketExpiry(new Date("2026-06-14T22:00:00.000Z"));
    assert.equal(expiry.toISOString(), "2026-06-21T21:00:00.000Z");
  });
});

describe("market lifecycle operations", () => {
  it("closes expired markets idempotently", async () => {
    const db = new LifecycleDb();
    db.markets.push({
      market_id: "m1",
      market_address: "0xmarket",
      resolver_type: "AdminManual",
      lifecycle_status: "active",
      status: "Active",
      expires_at: "100",
    });

    const first = await closeExpiredMarkets(db.client as never, new Date(101_000));
    const second = await closeExpiredMarkets(db.client as never, new Date(101_000));

    assert.equal(first.length, 1);
    assert.equal(first[0]!.status, "closed");
    assert.equal(second.length, 0);
    assert.equal(db.markets[0]!["lifecycle_status"], "closed");
    assert.equal(db.actions.length, 1);
  });

  it("allows audited early close by Ocean operator", async () => {
    const db = new LifecycleDb();
    db.markets.push({
      market_id: "m1",
      market_address: "0xmarket",
      resolver_type: "AdminManual",
      lifecycle_status: "active",
      status: "Active",
      expires_at: "1000",
    });

    const result = await closeMarket(db.client as never, "M1", {
      actionId: "early-close-1",
      actorId: "ocean:dan",
      actorRole: "ocean_operator",
      reason: "manual schedule correction",
      now: new Date(10_000),
    });

    assert.equal(result.status, "closed");
    assert.equal(db.markets[0]!["close_actor_id"], "ocean:dan");
    assert.equal(db.actions[0]!["action_type"], "close");
  });

  it("requires admin confirmation before preparing a final outcome", async () => {
    const db = new LifecycleDb();
    db.markets.push({
      market_id: "m1",
      market_address: "0xmarket",
      resolver_type: "AdminManual",
      lifecycle_status: "closed",
      status: "Closed",
      expires_at: "100",
    });

    await assert.rejects(
      () => prepareResolution(db.client as never, "m1", {
        actionId: "resolve-1",
        actorId: "ocean:operator",
        actorRole: "ocean_operator",
        outcome: "Yes",
        evidence: "admin reviewed finalist announcement",
        source: "DarkBox admin",
        confirmed: true,
      }),
      /resolution requires admin/,
    );

    await assert.rejects(
      () => prepareResolution(db.client as never, "m1", {
        actionId: "resolve-1",
        actorId: "admin:fran",
        actorRole: "admin",
        outcome: "Yes",
        evidence: "admin reviewed finalist announcement",
        source: "DarkBox admin",
        confirmed: false,
      }),
      /confirmed=true/,
    );

    const result = await prepareResolution(db.client as never, "m1", {
      actionId: "resolve-1",
      actorId: "admin:fran",
      actorRole: "admin",
      outcome: "Yes",
      evidence: "admin reviewed finalist announcement",
      source: "DarkBox admin",
      confirmed: true,
    });

    assert.equal(result.status, "resolution_pending");
    assert.equal(db.markets[0]!["lifecycle_status"], "resolution_pending");
    assert.equal(db.markets[0]!["outcome"], "Yes");
    assert.equal(db.actions.length, 1);
    assert.deepEqual(result.onchainIntent?.["signing"], "pending-external-signer");
  });
});
