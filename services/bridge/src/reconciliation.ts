import type { Hex } from "viem";

/**
 * USDC accounting snapshot the reconciliation worker compares (spec 12.1).
 * All amounts are in USDC base units (6 decimals). USDC-only MVP: there is a
 * single asset, so accounting is not keyed by asset.
 */
export interface UsdcAccounting {
  confirmedDeposits: bigint;
  shadowMinted: bigint;
  confirmedShadowBurned: bigint;
  withdrawalsExecuted: bigint;
  emergencyWithdrawals: bigint;
  escrowBalance: bigint;
}

/** A single reconciliation invariant outcome. */
export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Which flow to freeze when an invariant is violated. */
export type FreezeFlow = "deposits" | "withdrawals" | null;

export interface ReconciliationReport {
  results: InvariantResult[];
  ok: boolean;
  freeze: FreezeFlow;
}

/**
 * Evaluates the section 12.1 invariants for the USDC ledger. Pending mints are
 * allowed to lag, so the deposits==mints check is "eventually" satisfied and
 * only flagged when mints EXCEED confirmed deposits (which is never legitimate).
 *
 * Never auto-corrects; callers log/alert and freeze the affected flow.
 */
export function reconcileUsdc(acc: UsdcAccounting): ReconciliationReport {
  const results: InvariantResult[] = [];

  // mints must never exceed confirmed deposits (deposits may temporarily exceed
  // mints while mints are still pending).
  results.push({
    name: "mints_le_confirmed_deposits",
    ok: acc.shadowMinted <= acc.confirmedDeposits,
    detail: `shadowMinted=${acc.shadowMinted} confirmedDeposits=${acc.confirmedDeposits}`,
  });

  // burns always precede public payouts.
  results.push({
    name: "burns_ge_withdrawals",
    ok: acc.confirmedShadowBurned >= acc.withdrawalsExecuted,
    detail: `confirmedShadowBurned=${acc.confirmedShadowBurned} withdrawalsExecuted=${acc.withdrawalsExecuted}`,
  });

  // escrow solvency.
  const owed =
    acc.confirmedDeposits - acc.withdrawalsExecuted - acc.emergencyWithdrawals;
  results.push({
    name: "escrow_solvent",
    ok: acc.escrowBalance >= owed,
    detail: `escrowBalance=${acc.escrowBalance} owed=${owed}`,
  });

  const ok = results.every((r) => r.ok);
  // A burns/withdrawals or solvency violation is a withdrawal-side problem;
  // a mints>deposits violation is a deposit-side problem.
  let freeze: FreezeFlow = null;
  if (!ok) {
    const mintViolation = !results[0]!.ok;
    freeze = mintViolation ? "deposits" : "withdrawals";
  }

  return { results, ok, freeze };
}

/** Cross-references that each id maps one-to-one (spec 12.1, last two lines). */
export interface CrossRefInput {
  shadowMintedOpIds: Hex[];
  confirmedDepositOpIds: Hex[];
  withdrawalExecutedIds: Hex[];
  confirmedBurnIds: Hex[];
}

export function checkCrossReferences(input: CrossRefInput): InvariantResult[] {
  const depositSet = new Set(input.confirmedDepositOpIds.map((h) => h.toLowerCase()));
  const burnSet = new Set(input.confirmedBurnIds.map((h) => h.toLowerCase()));

  const orphanMints = input.shadowMintedOpIds.filter(
    (id) => !depositSet.has(id.toLowerCase()),
  );
  const orphanWithdrawals = input.withdrawalExecutedIds.filter(
    (id) => !burnSet.has(id.toLowerCase()),
  );

  return [
    {
      name: "every_mint_has_deposit",
      ok: orphanMints.length === 0,
      detail: `orphanMints=${orphanMints.length}`,
    },
    {
      name: "every_withdrawal_has_burn",
      ok: orphanWithdrawals.length === 0,
      detail: `orphanWithdrawals=${orphanWithdrawals.length}`,
    },
  ];
}
