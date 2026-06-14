import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedEvent } from "../src/adapters/types.js";
import { applyFrontierEvent } from "../src/reducers/frontier.js";
import { applyPmFactoryEvent, applyPmMarketEvent } from "../src/reducers/pm.js";
import { takeSnapshotWithClient } from "../src/reducers/snapshots.js";
import { hasForbiddenKey, toPublicLeaderboardEntry } from "../src/routes/public.js";
import { MockDb } from "./helpers/mockDb.js";

const OWNER = "0xowner0000000000000000000000000000000001";
const AGENT_ID = "agent-pnl-acceptance";
const SHADOW = "0xshadow000000000000000000000000000000001";
const GAME_ID = "game-pnl-acceptance";
const DEPOSIT = "100000000";

function event(
  eventName: string,
  adapter: NormalizedEvent["adapter"],
  decoded: Record<string, unknown>,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    chainId: 1337,
    blockNumber: BigInt(overrides.blockNumber ?? 100n),
    blockTimestamp: BigInt(overrides.blockTimestamp ?? 1_700_000_000n),
    txHash: (overrides.txHash ?? `0x${"aa".repeat(31)}01`) as `0x${string}`,
    txFrom: overrides.txFrom,
    logIndex: overrides.logIndex ?? 0,
    contractAddress: (overrides.contractAddress ?? "0x1111111111111111111111111111111111111111") as `0x${string}`,
    adapter,
    eventName,
    decoded,
  };
}

function marketId(i: number): string {
  return `market-${String(i).padStart(2, "0")}`;
}

function book(i: number, outcome: "yes" | "no"): string {
  return `0x${i.toString(16).padStart(38, "0")}${outcome === "yes" ? "aa" : "bb"}`;
}

function assertIncludes(row: Record<string, unknown> | undefined, expected: Record<string, unknown>): void {
  assert.ok(row, "expected row to exist");
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(row[key], value, key);
  }
}

describe("production PnL acceptance fixture", () => {
  it("materializes exact 20-market PnL for one owner/agent/shadow account", async () => {
    const db = new MockDb();
    const c = db.client as never;

    db.getTable("agents").push({
      agent_id: AGENT_ID,
      game_id: GAME_ID,
      owner_address: OWNER,
      shadow_account: SHADOW,
      ens_name: "pnl.eth",
    });
    db.getTable("balances").push({
      shadow_account: SHADOW,
      asset: "USDC",
      total_deposited: DEPOSIT,
      total_withdrawn: "0",
      current_balance: DEPOSIT,
    });

    for (let i = 1; i <= 20; i++) {
      await applyPmFactoryEvent(
        c,
        event("MarketCreated", "pm_factory", {
          gameId: GAME_ID,
          marketId: marketId(i),
          creator: OWNER,
          market: `0x${i.toString(16).padStart(40, "0")}`,
          question: `Market ${i}`,
          metadataURI: `fixture://${i}`,
          closeTime: 1_800_000_000n,
          resolveBy: 1_800_086_400n,
          resolverType: 0,
        }),
      );
      await applyPmFactoryEvent(
        c,
        event("BooksRegistered", "pm_factory", {
          marketId: marketId(i),
          yesBook: book(i, "yes"),
          noBook: book(i, "no"),
          yesToken: `yes-${i}`,
          noToken: `no-${i}`,
        }),
      );
      await applyPmMarketEvent(
        c,
        event("Split", "pm_market", {
          marketId: marketId(i),
          caller: OWNER,
          receiver: OWNER,
          amount: 1_000_000n,
        }),
      );
      for (const outcome of ["yes", "no"] as const) {
        await applyFrontierEvent(
          c,
          event(
            "RunFilled",
            "frontier",
            { fromLevel: 0, toBoundary: 0, startSize: 1_000_000n, slopePerLevel: 0n, clock: BigInt(i) },
            {
              contractAddress: book(i, outcome) as `0x${string}`,
              txHash: `0x${i.toString(16).padStart(62, "0")}${outcome === "yes" ? "01" : "02"}` as `0x${string}`,
              logIndex: outcome === "yes" ? 1 : 2,
            },
          ),
        );
      }
    }

    await applyPmMarketEvent(
      c,
      event("Joined", "pm_market", { marketId: marketId(1), caller: OWNER, receiver: OWNER, amount: 100_000n }),
    );
    await applyPmMarketEvent(
      c,
      event("Redeemed", "pm_market", { marketId: marketId(2), caller: OWNER, receiver: OWNER, outcome: 1, amount: 200_000n }),
    );

    await applyFrontierEvent(
      c,
      event("Deposit", "frontier", { positionId: 3001n, owner: OWNER, lower: 0, upper: 0, liquidity: 100_000n }, { contractAddress: book(3, "yes") as `0x${string}`, txHash: `0x${"03".repeat(32)}`, logIndex: 1 }),
    );
    await applyFrontierEvent(
      c,
      event("Claim", "frontier", { positionId: 3001n, proceeds1: 70_000n }, { contractAddress: book(3, "yes") as `0x${string}`, txHash: `0x${"04".repeat(32)}`, logIndex: 2 }),
    );
    await applyFrontierEvent(
      c,
      event("Deposit", "frontier", { positionId: 4001n, owner: OWNER, lower: 0, upper: 0, liquidity: 50_000n }, { contractAddress: book(4, "no") as `0x${string}`, txHash: `0x${"05".repeat(32)}`, logIndex: 1 }),
    );
    await applyFrontierEvent(
      c,
      event("Cancel", "frontier", { positionId: 4001n, proceeds1: 0n, principal0: 50_000n }, { contractAddress: book(4, "no") as `0x${string}`, txHash: `0x${"06".repeat(32)}`, logIndex: 2 }),
    );

    await takeSnapshotWithClient(db.client as never);

    const positions = db.getTable("positions");
    assert.equal(positions.length, 40);
    assertIncludes(positions.find((p) => p["market_id"] === marketId(1) && p["outcome"] === "Yes"), {
      quantity: "900000",
      cost_basis: "450000",
      realized_pnl: "0",
    });
    assertIncludes(positions.find((p) => p["market_id"] === marketId(2) && p["outcome"] === "Yes"), {
      quantity: "800000",
      cost_basis: "400000",
      realized_pnl: "100000",
    });
    assertIncludes(positions.find((p) => p["market_id"] === marketId(3) && p["outcome"] === "Yes"), {
      quantity: "900000",
      cost_basis: "450000",
      realized_pnl: "20000",
    });

    const snapshot = db.getTable("pnl_snapshots")[0]!;
    assertIncludes(snapshot, {
      shadow_account: SHADOW,
      net_deposits: "100000000",
      realized_pnl: "120000",
      unrealized_pnl: "19750000",
      total_pnl: "19870000",
      current_balance: "80370000",
      equity: "119870000",
      rank: 1,
    });

    const leaderboardRow = db.getTable("leaderboard_snapshots")[0]!;
    assertIncludes(leaderboardRow, {
      agent_id: AGENT_ID,
      rank: 1,
      realized_pnl: "120000",
      unrealized_pnl: "19750000",
      total_pnl: "19870000",
      equity: "119870000",
      net_deposits: "100000000",
    });
    assert.deepEqual(toPublicLeaderboardEntry(leaderboardRow as never), {
      agentId: AGENT_ID,
      ensName: "pnl.eth",
      rank: 1,
      pnl: "19870000",
      realizedPnl: "120000",
      unrealizedPnl: "19750000",
      pnlPct: "19.8700",
      equity: "119870000",
      netDeposits: "100000000",
    });
    assert.equal(hasForbiddenKey(toPublicLeaderboardEntry(leaderboardRow as never)), false);

    const orders = db.getTable("orders");
    assert.equal(orders.find((o) => o["position_id"] === "3001")?.["status"], "filled");
    assert.equal(orders.find((o) => o["position_id"] === "4001")?.["status"], "cancelled");
    assert.equal(db.getTable("markets").every((m) => m["latest_yes_price"] === "1000000" && m["latest_no_price"] === "1000000"), true);
  });

  it("attributes direct taker fills from txFrom and includes them in PnL", async () => {
    const db = new MockDb();
    const c = db.client as never;

    db.getTable("agents").push({
      agent_id: AGENT_ID,
      game_id: GAME_ID,
      owner_address: OWNER,
      shadow_account: SHADOW,
      ens_name: "pnl.eth",
    });
    db.getTable("balances").push({
      shadow_account: SHADOW,
      asset: "USDC",
      total_deposited: "1000000",
      total_withdrawn: "0",
      current_balance: "1000000",
    });

    await applyPmFactoryEvent(
      c,
      event("MarketCreated", "pm_factory", {
        gameId: GAME_ID,
        marketId: marketId(21),
        creator: OWNER,
        market: `0x${"21".padStart(40, "0")}`,
        question: "Direct taker market",
        metadataURI: "fixture://direct-taker",
        closeTime: 1_800_000_000n,
        resolveBy: 1_800_086_400n,
        resolverType: 0,
      }),
    );
    await applyPmFactoryEvent(
      c,
      event("BooksRegistered", "pm_factory", {
        marketId: marketId(21),
        yesBook: book(21, "yes"),
        noBook: book(21, "no"),
        yesToken: "yes-21",
        noToken: "no-21",
      }),
    );

    await applyFrontierEvent(
      c,
      event(
        "IntervalFilled",
        "frontier",
        { lowerTick: 0, liquidity: 100_000n, proceeds1: 70_000n, clock: 1n },
        {
          contractAddress: book(21, "yes") as `0x${string}`,
          txHash: `0x${"21".repeat(32)}`,
          txFrom: OWNER,
          logIndex: 1,
        },
      ),
    );
    await applyFrontierEvent(
      c,
      event(
        "TakerFee",
        "frontier",
        { payer: OWNER, token: "0xc011a73a10000000000000000000000000000000", grossInput: 70_000n, fee: 1_000n, totalPaid: 71_000n },
        {
          contractAddress: book(21, "yes") as `0x${string}`,
          txHash: `0x${"21".repeat(32)}`,
          txFrom: OWNER,
          logIndex: 2,
        },
      ),
    );

    await takeSnapshotWithClient(db.client as never);

    const position = db.getTable("positions").find((p) => p["market_id"] === marketId(21) && p["outcome"] === "Yes");
    assertIncludes(position, {
      shadow_account: SHADOW,
      quantity: "100000",
      cost_basis: "71000",
      realized_pnl: "0",
      market_value: "100000",
      unrealized_pnl: "29000",
    });
    assert.equal(db.getTable("balances")[0]?.["current_balance"], "929000");

    const fill = db.getTable("fills")[0]!;
    assertIncludes(fill, {
      owner_address: OWNER,
      shadow_account: SHADOW,
      market_id: marketId(21),
      amount0: "100000",
      amount1: "70000",
    });

    const snapshot = db.getTable("pnl_snapshots")[0]!;
    assertIncludes(snapshot, {
      realized_pnl: "0",
      unrealized_pnl: "29000",
      total_pnl: "29000",
      current_balance: "929000",
      equity: "1029000",
    });
    assert.deepEqual(toPublicLeaderboardEntry(db.getTable("leaderboard_snapshots")[0] as never), {
      agentId: AGENT_ID,
      ensName: "pnl.eth",
      rank: 1,
      pnl: "29000",
      realizedPnl: "0",
      unrealizedPnl: "29000",
      pnlPct: "2.9000",
      equity: "1029000",
      netDeposits: "1000000",
    });
  });

  it("attributes upward and downward direct RunFilled sweeps from txFrom", async () => {
    const db = new MockDb();
    const c = db.client as never;

    db.getTable("agents").push({
      agent_id: AGENT_ID,
      game_id: GAME_ID,
      owner_address: OWNER,
      shadow_account: SHADOW,
      ens_name: "pnl.eth",
    });
    db.getTable("balances").push({
      shadow_account: SHADOW,
      asset: "USDC",
      total_deposited: "1000000",
      total_withdrawn: "0",
      current_balance: "1000000",
    });
    await applyPmFactoryEvent(
      c,
      event("MarketCreated", "pm_factory", {
        gameId: GAME_ID,
        marketId: marketId(22),
        creator: OWNER,
        market: `0x${"22".padStart(40, "0")}`,
        question: "Run taker market",
        metadataURI: "fixture://run-taker",
        closeTime: 1_800_000_000n,
        resolveBy: 1_800_086_400n,
        resolverType: 0,
      }),
    );
    await applyPmFactoryEvent(
      c,
      event("BooksRegistered", "pm_factory", {
        marketId: marketId(22),
        yesBook: book(22, "yes"),
        noBook: book(22, "no"),
        yesToken: "yes-22",
        noToken: "no-22",
      }),
    );

    await applyFrontierEvent(
      c,
      event(
        "RunFilled",
        "frontier",
        { fromLevel: 0, toBoundary: 1, startSize: 100_000n, slopePerLevel: 0n, clock: 1n },
        { contractAddress: book(22, "no") as `0x${string}`, txHash: `0x${"22".repeat(32)}`, txFrom: OWNER, logIndex: 1 },
      ),
    );
    await applyFrontierEvent(
      c,
      event(
        "RunFilled",
        "frontier",
        { fromLevel: 1, toBoundary: 0, startSize: 40_000n, slopePerLevel: 0n, clock: 2n },
        { contractAddress: book(22, "no") as `0x${string}`, txHash: `0x${"23".repeat(32)}`, txFrom: OWNER, logIndex: 2 },
      ),
    );

    const position = db.getTable("positions").find((p) => p["market_id"] === marketId(22) && p["outcome"] === "No");
    assertIncludes(position, {
      shadow_account: SHADOW,
      quantity: "60000",
      cost_basis: "60006",
      realized_pnl: "-4",
    });
    assert.equal(db.getTable("balances")[0]?.["current_balance"], "939990");
  });

  it.todo("reconstructs exact multi-level RunFilled quantities/costs after book tick spacing is persisted with market book metadata");
  it.todo("updates positions on Requote/PositionTransferred once reducer support is added for the existing Frontier events");
});
