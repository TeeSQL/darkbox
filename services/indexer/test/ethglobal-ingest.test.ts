import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockDb } from "./helpers/mockDb.js";
import { parseEthGlobalShowcaseHtml } from "../src/ethglobal/parser.js";
import { storeEthGlobalFetchWithClient } from "../src/ethglobal/store.js";

const PROJECTS = [
  {
    uuid: "abc12",
    slug: "darkbox",
    name: "DarkBox",
    tagline: "Hidden-state prediction markets.",
    event: { name: "ETHGlobal New York 2026" },
    prizes: [
      {
        prize: {
          name: "Best use of private compute",
          amount: "$5,000",
          sponsor: { organization: { name: "Phala" } },
        },
        rank: "winner",
      },
    ],
    meta: {
      autoSummary: "A longer generated summary that should not beat the shorter tagline.",
      demoVideoReady: true,
    },
  },
];

function fixtureHtml(projects = PROJECTS): string {
  const payload = JSON.stringify({
    events: [{ slug: "ethnyc2026", name: "ETHGlobal New York 2026" }],
    projects,
  }).replace(/"/g, '\\"');
  return `<script>self.__next_f.push([1,"${payload}"])</script>`;
}

describe("ETHGlobal ingest", () => {
  it("normalizes embedded showcase projects into compact records", () => {
    const result = parseEthGlobalShowcaseHtml(
      "ethnyc2026",
      "https://ethglobal.com/showcase?events=ethnyc2026",
      fixtureHtml(),
      new Date("2026-06-14T00:00:00.000Z"),
    );

    assert.equal(result.eventName, "ETHGlobal New York 2026");
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]?.externalProjectId, "abc12");
    assert.equal(result.projects[0]?.externalProjectSlug, "darkbox");
    assert.equal(result.projects[0]?.shortestDescription, "Hidden-state prediction markets.");
    assert.deepEqual(result.projects[0]?.sponsors, ["Phala"]);
    assert.equal(result.projects[0]?.prizes[0]?.name, "Best use of private compute");
  });

  it("stores event, projects, and ingest run with idempotent upsert SQL", async () => {
    const db = new MockDb();
    const parsed = parseEthGlobalShowcaseHtml(
      "ethnyc2026",
      "https://ethglobal.com/showcase?events=ethnyc2026",
      fixtureHtml(),
      new Date("2026-06-14T00:00:00.000Z"),
    );

    const result = await storeEthGlobalFetchWithClient(db.client as never, parsed);

    assert.equal(result.projectCount, 1);
    assert.equal(db.getTable("ethglobal_events").length, 1);
    assert.equal(db.getTable("ethglobal_projects").length, 1);
    assert.equal(db.getTable("ethglobal_ingest_runs").length, 1);

    await storeEthGlobalFetchWithClient(db.client as never, parsed);
    assert.equal(db.getTable("ethglobal_events").length, 1);
    assert.equal(db.getTable("ethglobal_projects").length, 1);
    assert.equal(db.getTable("ethglobal_ingest_runs").length, 2);

    const project = db.getTable("ethglobal_projects")[0]!;
    assert.equal(project["event_slug"], "ethnyc2026");
    assert.equal(project["external_project_slug"], "darkbox");
  });

  it("records a successful empty event fetch", async () => {
    const db = new MockDb();
    const parsed = parseEthGlobalShowcaseHtml(
      "ethnyc2026",
      "https://ethglobal.com/showcase?events=ethnyc2026",
      fixtureHtml([]),
      new Date("2026-06-14T00:00:00.000Z"),
    );

    const result = await storeEthGlobalFetchWithClient(db.client as never, parsed);
    assert.equal(result.projectCount, 0);
    assert.equal(db.getTable("ethglobal_events").length, 1);
    assert.equal(db.getTable("ethglobal_projects").length, 0);
    assert.equal(db.getTable("ethglobal_ingest_runs")[0]?.["status"], "ok");
  });
});
