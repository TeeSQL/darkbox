/**
 * Reveal bundle assembly + accounting reconciliation.
 *
 * `buildRevealBundle` is a pure-ish function of (sources, meta): it pulls every
 * piece, reconciles public-USDC vs shadow accounting, builds the replay
 * timeline, applies the reveal policy (strip instruction preimages unless
 * allowed), and stamps an integrity hash over the whole bundle.
 */
import { keccak256, toHex, type Hex } from "viem";
import type { AccountingRecord, RevealBundle, RevealMeta, RevealSources } from "./types.js";

/** Parse a decimal USDC string into integer micro-USDC (6 dp) to avoid float drift. */
function toMicro(s: string): bigint {
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const micro = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6) || "0");
  return neg ? -micro : micro;
}

function fromMicro(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  return `${neg ? "-" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

export function reconcileAccounting(
  raw: Omit<AccountingRecord, "reconciled" | "discrepancyUsdc">,
): AccountingRecord {
  // Mint-backing invariant: shadowMinted == publicDeposited + promoCredited.
  const discrepancy = toMicro(raw.shadowMintedUsdc) - (toMicro(raw.publicDepositedUsdc) + toMicro(raw.promoCreditedUsdc));
  return {
    ...raw,
    reconciled: discrepancy === 0n,
    discrepancyUsdc: fromMicro(discrepancy),
  };
}

export async function buildRevealBundle(
  sources: RevealSources,
  meta: RevealMeta,
): Promise<RevealBundle> {
  const [deployments, markets, orders, fills, positions, leaderboard, agentsRaw, rawEvents, acctRaw] =
    await Promise.all([
      sources.getDeployments(),
      sources.getMarkets(),
      sources.getOrders(),
      sources.getFills(),
      sources.getPositions(),
      sources.getLeaderboard(),
      sources.getAgents(),
      sources.getRawEvents(),
      sources.getAccounting(),
    ]);

  // Reveal policy: strip instruction preimages unless explicitly allowed.
  const agents = agentsRaw.map((a) =>
    meta.revealPolicy.includeInstructions ? a : { ...a, revealedInstruction: undefined },
  );

  const accounting = reconcileAccounting(acctRaw);

  const revealOpenedAt = rawEvents.reduce((m, e) => Math.max(m, e.t), 0) + 1;
  // Lazy import to keep this module dependency-light.
  const { buildTimeline } = await import("./timeline.js");
  const timeline = buildTimeline(rawEvents, revealOpenedAt);

  const core = {
    meta,
    deployments,
    markets,
    orders,
    fills,
    positions,
    leaderboard,
    agents,
    accounting,
    timeline,
  };
  const bundleHash: Hex = keccak256(toHex(stableStringify(core)));

  return { ...core, integrity: { bundleHash, eventCount: timeline.length } };
}

/** Deterministic JSON (sorted keys) so the integrity hash is stable. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}
