/**
 * Demo faucet — direct ERC20 sUSDC credit.
 *
 * Mints $5 of TRADABLE SyntheticUSDC straight to a new user's trading address so
 * they can immediately approve / split / place orders. This is deliberately NOT
 * routed through faucet-mint-worker / ShadowBridgeController.mintShadow — that
 * credits a non-tradable internal shadow ledger. The markets/Frontier trade real
 * ERC20 sUSDC balances + allowances, so the faucet mints the ERC20 itself.
 *
 * `grantDemoFaucet` is a pure async function of its injected deps (chain + store)
 * so the whole flow is unit-testable with no network and no Postgres.
 */
import type { Address, Hex } from "viem";

/** Persisted grant record (one per wallet AND per Telegram user). */
export interface DemoFaucetGrant {
  id: number;
  address: string; // lowercased recipient wallet
  tgId: string | null;
  /** null while the slot is reserved (status "pending"); set once minted. */
  txHash: string | null;
  amount: string; // base-unit string, e.g. "5000000"
  status: "pending" | "granted";
}

/**
 * Persistence seam — the real impl wraps the indexer Postgres; tests fake it.
 *
 * The reserve→finalize pair makes minting at-most-once under concurrency: a
 * reservation row is inserted (under the unique constraints) BEFORE the mint, so
 * only one of two simultaneous same-wallet claims can hold the slot and mint.
 */
export interface DemoFaucetStore {
  /** First existing grant matching this wallet OR (when given) this tg id. */
  findGrant(address: string, tgId: string | null): Promise<DemoFaucetGrant | null>;
  /** Total rows (pending + granted) — counts reservations against the cap. */
  countGrants(): Promise<number>;
  /**
   * Reserve a slot by inserting a `pending` row (tx_hash NULL). Returns the
   * reservation, or `null` if a unique constraint (per-wallet / per-tg) rejected
   * it — i.e. a concurrent claim already holds the slot; the caller skips the
   * mint and replays the winner.
   */
  reserveGrant(reservation: {
    address: string;
    tgId: string | null;
    amount: string;
  }): Promise<DemoFaucetGrant | null>;
  /** Promote a reservation to `granted` with the real mint tx hash. */
  finalizeGrant(id: number, txHash: string): Promise<DemoFaucetGrant>;
  /** Drop a reservation (mint failed) so the wallet can retry cleanly. */
  releaseGrant(id: number): Promise<void>;
}

/** Chain seam — reads minter(), exposes the signer address, mints + waits. */
export interface DemoFaucetChain {
  /** Address derived from the sealed minter key (the tx sender). */
  signerAddress(): Address;
  /** On-chain SyntheticUSDC.minter() view. */
  readMinter(): Promise<Address>;
  /** SyntheticUSDC.mint(to, amount); resolves to the tx hash after the receipt. */
  mint(to: Address, amount: bigint): Promise<Hex>;
}

export interface DemoFaucetDeps {
  chain: DemoFaucetChain;
  store: DemoFaucetStore;
  tokenAddress: Address; // SyntheticUSDC address, echoed back as `token`
  amount: bigint; // micro-USDC to mint per grant (5_000_000)
  globalCap: number;
  /** Optional structured logger (txHash + recipient + signer only — never keys). */
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface DemoFaucetInput {
  address?: string | undefined;
  tgId?: string | null | undefined;
}

export interface DemoFaucetResult {
  statusCode: number;
  body: Record<string, unknown>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function granted(grant: DemoFaucetGrant, token: Address, status: "granted" | "already_granted"): DemoFaucetResult {
  return {
    statusCode: 200,
    body: {
      txHash: grant.txHash, // null only for a reservation still mid-mint (client polls balanceOf)
      amount: grant.amount,
      token,
      recipient: grant.address,
      status,
    },
  };
}

/**
 * Resolve recipient, enforce guardrails, mint once, persist — idempotently.
 *
 * Order is deliberate:
 *  1. validate address                        → 400 invalid_address
 *  2. idempotent read (no chain calls)        → 200 already_granted
 *  3. pre-mint minter check (no reverting tx) → 503 demo_faucet_not_minter
 *  4. global cap                              → 429 demo_faucet_cap_reached
 *  5. RESERVE the slot (unique insert)        → 200 already_granted if a
 *                                               concurrent claim won (no mint)
 *  6. mint, then finalize the reservation     → 200 granted
 *
 * Reserve-before-mint (step 5) is what makes minting at-most-once: two truly
 * simultaneous same-wallet claims both pass step 2, but only ONE reservation
 * survives the unique constraint, so only one mints. Idempotency is checked
 * before the minter check so a retry always replays its record even if the
 * minter was later rotated.
 */
export async function grantDemoFaucet(
  deps: DemoFaucetDeps,
  input: DemoFaucetInput,
): Promise<DemoFaucetResult> {
  const { chain, store, tokenAddress, amount, globalCap, log } = deps;

  // 1. Validate recipient address.
  const raw = (input.address ?? "").trim();
  if (!ADDRESS_RE.test(raw)) {
    return { statusCode: 400, body: { error: "invalid_address" } };
  }
  const address = raw.toLowerCase();
  const tgId = input.tgId ?? null;

  // 2. Idempotent read — repeat claim (same wallet OR same tg user) replays the
  //    existing grant and NEVER mints again.
  const existing = await store.findGrant(address, tgId);
  if (existing) {
    return granted(existing, tokenAddress, "already_granted");
  }

  // 3. Pre-mint minter check: assert SyntheticUSDC.minter() == our signer so we
  //    never broadcast a tx that would revert.
  const signer = chain.signerAddress();
  const minter = await chain.readMinter();
  if (minter.toLowerCase() !== signer.toLowerCase()) {
    log?.({ signer, minter }, "demo faucet: signer is not the sUSDC minter");
    return { statusCode: 503, body: { error: "demo_faucet_not_minter" } };
  }

  // 4. Global cap (counts pending reservations too).
  const count = await store.countGrants();
  if (count >= globalCap) {
    return { statusCode: 429, body: { error: "demo_faucet_cap_reached" } };
  }

  // 5. Reserve the slot BEFORE minting. Losing the unique race means another
  //    concurrent claim already holds this wallet/tg slot — skip the mint and
  //    replay the winner (never double-mint).
  const reservation = await store.reserveGrant({ address, tgId, amount: amount.toString() });
  if (!reservation) {
    const winner = await store.findGrant(address, tgId);
    log?.({ recipient: address }, "demo faucet: concurrent claim lost reservation race");
    // `winner` is virtually always present (the race winner's row); fall back to
    // already_granted regardless so a loser never mints.
    return granted(
      winner ?? { id: -1, address, tgId, txHash: null, amount: amount.toString(), status: "pending" },
      tokenAddress,
      "already_granted",
    );
  }

  // 6. Mint, then finalize. If the mint fails, release the reservation so the
  //    wallet can retry cleanly instead of being stuck on a dead pending row.
  let txHash: Hex;
  try {
    txHash = await chain.mint(address as Address, amount);
  } catch (err) {
    await store.releaseGrant(reservation.id);
    log?.({ recipient: address }, "demo faucet: mint failed, reservation released");
    throw err;
  }
  const stored = await store.finalizeGrant(reservation.id, txHash);

  log?.({ recipient: address, txHash, signer }, "demo faucet: minted demo credit");
  return granted(stored, tokenAddress, "granted");
}
