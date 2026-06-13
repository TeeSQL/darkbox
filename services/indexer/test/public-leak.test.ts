import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripForbidden, hasForbiddenKey } from "../src/routes/public.js";

describe("public leak guard (stripForbidden)", () => {
  it("removes shadow_account from a flat object", () => {
    const input = {
      agent_id: "0xaaa",
      ens_name: "alice.eth",
      shadow_account: "0xsecret",
      rank: 1,
    };
    const out = stripForbidden(input) as Record<string, unknown>;
    assert.equal(out["shadow_account"], undefined, "shadow_account must be removed");
    assert.equal(out["agent_id"], "0xaaa");
    assert.equal(out["rank"], 1);
  });

  it("removes forbidden keys nested in arrays", () => {
    const input = [
      { agent_id: "0xaaa", current_balance: "1000", rank: 1 },
      { agent_id: "0xbbb", current_balance: "2000", rank: 2 },
    ];
    const out = stripForbidden(input) as Record<string, unknown>[];
    for (const item of out) {
      assert.equal(item["current_balance"], undefined, "current_balance must be stripped");
      assert.ok(item["agent_id"], "agent_id should remain");
    }
  });

  it("removes all known forbidden keys", () => {
    const forbidden = [
      "shadow_account",
      "shadowAccount",
      "current_balance",
      "currentBalance",
      "total_deposited",
      "totalDeposited",
      "total_withdrawn",
      "totalWithdrawn",
      "total_credited",
      "totalCredited",
      "total_burned",
      "totalBurned",
      "orders",
      "fills",
      "positions",
      "orderbook",
      "raw_data",
      "rawData",
      "instruction_hash",
      "instructionHash",
      "runtime_hash",
      "runtimeHash",
      "reveal_salt_hash",
      "revealSaltHash",
      "tx_hash",
      "txHash",
      "log_index",
      "logIndex",
    ];
    const input: Record<string, unknown> = {};
    for (const k of forbidden) input[k] = "secret";
    input["safe_field"] = "public";

    const out = stripForbidden(input) as Record<string, unknown>;
    for (const k of forbidden) {
      assert.equal(out[k], undefined, `${k} must not appear in public output`);
    }
    assert.equal(out["safe_field"], "public");
  });

  it("hasForbiddenKey returns false for clean objects", () => {
    const clean = { agentId: "0xaaa", rank: 1, pnl: "100" };
    assert.equal(hasForbiddenKey(clean), false);
  });

  it("hasForbiddenKey returns true when a forbidden key is present", () => {
    const dirty = { agentId: "0xaaa", shadow_account: "0xsecret" };
    assert.equal(hasForbiddenKey(dirty), true);
  });

  it("hasForbiddenKey detects forbidden keys in nested objects", () => {
    // txHash is forbidden even when nested
    const nested = { data: { fill: { txHash: "0xabc" } } };
    assert.equal(hasForbiddenKey(nested), true, "txHash nested in object should be detected");
    const nested2 = { data: { fills: [] } };
    assert.equal(hasForbiddenKey(nested2), true, "fills nested should be detected");
  });

  it("public leaderboard shape has no forbidden keys", () => {
    const leaderboardEntry = {
      agentId: "0xaaa",
      ensName: "alice.eth",
      rank: 1,
      pnl: "100",
      pnlPct: "10.0",
      equity: "1100",
      netDeposits: "1000",
    };
    assert.equal(
      hasForbiddenKey(leaderboardEntry),
      false,
      "leaderboard entry should contain no forbidden keys",
    );
  });
});
