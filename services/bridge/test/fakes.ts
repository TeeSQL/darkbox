import { keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  InsufficientAvailableError,
  type ShadowBurnSubmitter,
  type ShadowMintSubmitter,
} from "../src/shadow.js";
import type { NonceChecker, ShadowBurnVerifier } from "../src/signingService.js";

const k = (shadow: Hex) => shadow.toLowerCase();

interface BurnEntry {
  ref: Hex;
  amount: bigint;
}

/**
 * In-memory model of the shadow bridge controller, mirroring its on-chain
 * semantics (idempotent mint, available-balance burn, used-nonce tracking).
 * Implements every shadow-side interface the bridge service depends on, so the
 * coordinators can be unit-tested without a live chain. USDC-only: balances are
 * keyed by shadow account (single asset).
 */
export class FakeShadowChain
  implements ShadowMintSubmitter, ShadowBurnSubmitter, ShadowBurnVerifier, NonceChecker
{
  balances = new Map<string, bigint>();
  locked = new Map<string, bigint>();
  mints = new Map<string, Hex>(); // depositOpId -> tx
  burns = new Map<string, BurnEntry>(); // withdrawalId -> entry
  usedNonces = new Set<string>();

  // --- test seam: simulate orders/collateral locking funds ---
  setBalance(shadow: Hex, amount: bigint) {
    this.balances.set(k(shadow), amount);
  }
  setLocked(shadow: Hex, amount: bigint) {
    this.locked.set(k(shadow), amount);
  }
  useNonce(owner: Address, nonce: bigint) {
    this.usedNonces.add(`${owner.toLowerCase()}:${nonce}`);
  }

  // --- ShadowMintSubmitter ---
  async mintShadow(p: {
    depositOpId: Hex;
    owner: Address;
    shadowAccount: Hex;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    const existing = this.mints.get(p.depositOpId.toLowerCase());
    if (existing) return { txHash: existing };
    const key = k(p.shadowAccount);
    this.balances.set(key, (this.balances.get(key) ?? 0n) + p.amount);
    const txHash = keccak256(stringToHex(`mint:${p.depositOpId}`));
    this.mints.set(p.depositOpId.toLowerCase(), txHash);
    return { txHash };
  }
  async findExistingMint(depositOpId: Hex): Promise<Hex | null> {
    return this.mints.get(depositOpId.toLowerCase()) ?? null;
  }

  // --- ShadowBurnSubmitter ---
  async withdrawableBalance(shadow: Hex): Promise<bigint> {
    const bal = this.balances.get(k(shadow)) ?? 0n;
    const lk = this.locked.get(k(shadow)) ?? 0n;
    return bal > lk ? bal - lk : 0n;
  }
  async burnForWithdrawal(p: {
    withdrawalId: Hex;
    owner: Address;
    shadowAccount: Hex;
    amount: bigint;
    userCommandHash: Hex;
  }): Promise<{ shadowBurnRef: Hex }> {
    const existing = this.burns.get(p.withdrawalId.toLowerCase());
    if (existing) return { shadowBurnRef: existing.ref };
    const available = await this.withdrawableBalance(p.shadowAccount);
    if (available < p.amount) {
      throw new InsufficientAvailableError(p.shadowAccount, p.amount, available);
    }
    const key = k(p.shadowAccount);
    this.balances.set(key, (this.balances.get(key) ?? 0n) - p.amount);
    const ref = keccak256(stringToHex(`burn:${p.withdrawalId}`));
    this.burns.set(p.withdrawalId.toLowerCase(), { ref, amount: p.amount });
    return { shadowBurnRef: ref };
  }
  async findExistingBurn(withdrawalId: Hex): Promise<Hex | null> {
    return this.burns.get(withdrawalId.toLowerCase())?.ref ?? null;
  }

  // --- ShadowBurnVerifier ---
  async hasConfirmedBurn(p: {
    withdrawalId: Hex;
    shadowBurnRef: Hex;
    amount: bigint;
  }): Promise<boolean> {
    const entry = this.burns.get(p.withdrawalId.toLowerCase());
    if (!entry) return false;
    return (
      entry.ref.toLowerCase() === p.shadowBurnRef.toLowerCase() &&
      entry.amount === p.amount
    );
  }

  // --- NonceChecker ---
  async isNonceUsed(owner: Address, nonce: bigint): Promise<boolean> {
    return this.usedNonces.has(`${owner.toLowerCase()}:${nonce}`);
  }
}
