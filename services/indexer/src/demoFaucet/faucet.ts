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
  address: string; // lowercased recipient wallet
  tgId: string | null;
  txHash: string;
  amount: string; // base-unit string, e.g. "5000000"
}

/** Persistence seam — the real impl wraps the indexer Postgres; tests fake it. */
export interface DemoFaucetStore {
  /** First existing grant matching this wallet OR (when given) this tg id. */
  findGrant(address: string, tgId: string | null): Promise<DemoFaucetGrant | null>;
  /** Total number of grants issued (for the global cap). */
  countGrants(): Promise<number>;
  /**
   * Insert a new grant. Returns the stored record, or `null` if a unique
   * constraint (per-wallet / per-tg) rejected it — i.e. a concurrent claim won
   * the race; the caller then re-reads the winning record.
   */
  insertGrant(grant: DemoFaucetGrant): Promise<DemoFaucetGrant | null>;
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
      txHash: grant.txHash,
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
 *  5. mint + persist                          → 200 granted
 *
 * Idempotency is checked BEFORE the minter check so a retry from a flaky mobile
 * client always replays its existing record even if the minter was later rotated.
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

  // 4. Global cap.
  const count = await store.countGrants();
  if (count >= globalCap) {
    return { statusCode: 429, body: { error: "demo_faucet_cap_reached" } };
  }

  // 5. Mint, then persist.
  const txHash = await chain.mint(address as Address, amount);
  const record: DemoFaucetGrant = {
    address,
    tgId,
    txHash,
    amount: amount.toString(),
  };
  const stored = await store.insertGrant(record);
  if (!stored) {
    // Lost a concurrent race after minting; re-read the winning record so the
    // client still gets a consistent (already_granted) answer.
    const winner = await store.findGrant(address, tgId);
    if (winner) {
      log?.({ recipient: address, txHash, winnerTxHash: winner.txHash }, "demo faucet: concurrent grant race");
      return granted(winner, tokenAddress, "already_granted");
    }
    // Extremely unlikely: insert rejected but no row found. Surface our mint.
    return granted(record, tokenAddress, "granted");
  }

  log?.({ recipient: address, txHash, signer }, "demo faucet: minted demo credit");
  return granted(stored, tokenAddress, "granted");
}
