import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import {
  checkCrossReferences,
  reconcileUsdc,
  type UsdcAccounting,
} from "../src/reconciliation.js";

const balanced: UsdcAccounting = {
  confirmedDeposits: 1_000_000n,
  shadowMinted: 1_000_000n,
  confirmedShadowBurned: 400_000n,
  withdrawalsExecuted: 400_000n,
  emergencyWithdrawals: 0n,
  escrowBalance: 600_000n,
};

test("a balanced ledger passes all invariants", () => {
  const report = reconcileUsdc(balanced);
  assert.equal(report.ok, true);
  assert.equal(report.freeze, null);
});

test("pending mints (deposits exceed mints) are allowed", () => {
  const report = reconcileUsdc({ ...balanced, shadowMinted: 800_000n });
  assert.equal(report.ok, true);
});

test("mints exceeding confirmed deposits freezes deposits", () => {
  const report = reconcileUsdc({ ...balanced, shadowMinted: 1_200_000n });
  assert.equal(report.ok, false);
  assert.equal(report.freeze, "deposits");
});

test("withdrawals exceeding confirmed burns freezes withdrawals", () => {
  const report = reconcileUsdc({ ...balanced, withdrawalsExecuted: 500_000n });
  assert.equal(report.ok, false);
  assert.equal(report.freeze, "withdrawals");
});

test("escrow insolvency freezes withdrawals", () => {
  const report = reconcileUsdc({ ...balanced, escrowBalance: 100_000n });
  assert.equal(report.ok, false);
  assert.equal(report.freeze, "withdrawals");
});

test("cross-references detect orphan mints and withdrawals", () => {
  const op: Hex = `0x${"11".repeat(32)}`;
  const wd: Hex = `0x${"22".repeat(32)}`;
  const ok = checkCrossReferences({
    shadowMintedOpIds: [op],
    confirmedDepositOpIds: [op],
    withdrawalExecutedIds: [wd],
    confirmedBurnIds: [wd],
  });
  assert.ok(ok.every((r) => r.ok));

  const bad = checkCrossReferences({
    shadowMintedOpIds: [op, `0x${"33".repeat(32)}`],
    confirmedDepositOpIds: [op],
    withdrawalExecutedIds: [wd],
    confirmedBurnIds: [],
  });
  assert.equal(bad.find((r) => r.name === "every_mint_has_deposit")?.ok, false);
  assert.equal(bad.find((r) => r.name === "every_withdrawal_has_burn")?.ok, false);
});
