import { keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  InsufficientAvailableError,
  type ShadowBurnSubmitter,
  type ShadowMintSubmitter,
} from "../src/shadow.js";
import type { NonceChecker, ShadowBurnVerifier } from "../src/signingService.js";

const key = (shadow: Hex, asset: Address) =>
  `${shadow.toLowerCase()}:${asset.toLowerCase()}`;

interface BurnEntry {
  ref: Hex;
  asset: Address;
  amount: bigint;
}

/**
 * In-memory model of the shadow bridge controller, mirroring its on-chain
 * semantics (idempotent mint, available-balance burn, used-nonce tracking).
 * Implements every shadow-side interface the bridge service depends on, so the
 * coordinators can be unit-tested without a live chain.
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
  setBalance(shadow: Hex, asset: Address, amount: bigint) {
    this.balances.set(key(shadow, asset), amount);
  }
  setLocked(shadow: Hex, asset: Address, amount: bigint) {
    this.locked.set(key(shadow, asset), amount);
  }
  useNonce(owner: Address, nonce: bigint) {
    this.usedNonces.add(`${owner.toLowerCase()}:${nonce}`);
  }

  // --- ShadowMintSubmitter ---
  async mintShadow(p: {
    depositOpId: Hex;
    owner: Address;
    shadowAccount: Hex;
    asset: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    const existing = this.mints.get(p.depositOpId.toLowerCase());
    if (existing) return { txHash: existing };
    const k = key(p.shadowAccount, p.asset);
    this.balances.set(k, (this.balances.get(k) ?? 0n) + p.amount);
    const txHash = keccak256(stringToHex(`mint:${p.depositOpId}`));
    this.mints.set(p.depositOpId.toLowerCase(), txHash);
    return { txHash };
  }
  async findExistingMint(depositOpId: Hex): Promise<Hex | null> {
    return this.mints.get(depositOpId.toLowerCase()) ?? null;
  }

  // --- ShadowBurnSubmitter ---
  async withdrawableBalance(shadow: Hex, asset: Address): Promise<bigint> {
    const k = key(shadow, asset);
    const bal = this.balances.get(k) ?? 0n;
    const lk = this.locked.get(k) ?? 0n;
    return bal > lk ? bal - lk : 0n;
  }
  async burnForWithdrawal(p: {
    withdrawalId: Hex;
    owner: Address;
    shadowAccount: Hex;
    asset: Address;
    amount: bigint;
    userCommandHash: Hex;
  }): Promise<{ shadowBurnRef: Hex }> {
    const existing = this.burns.get(p.withdrawalId.toLowerCase());
    if (existing) return { shadowBurnRef: existing.ref };
    const available = await this.withdrawableBalance(p.shadowAccount, p.asset);
    if (available < p.amount) {
      throw new InsufficientAvailableError(
        p.shadowAccount,
        p.asset,
        p.amount,
        available,
      );
    }
    const k = key(p.shadowAccount, p.asset);
    this.balances.set(k, (this.balances.get(k) ?? 0n) - p.amount);
    const ref = keccak256(stringToHex(`burn:${p.withdrawalId}`));
    this.burns.set(p.withdrawalId.toLowerCase(), {
      ref,
      asset: p.asset,
      amount: p.amount,
    });
    return { shadowBurnRef: ref };
  }
  async findExistingBurn(withdrawalId: Hex): Promise<Hex | null> {
    return this.burns.get(withdrawalId.toLowerCase())?.ref ?? null;
  }

  // --- ShadowBurnVerifier ---
  async hasConfirmedBurn(p: {
    withdrawalId: Hex;
    shadowBurnRef: Hex;
    asset: Address;
    amount: bigint;
  }): Promise<boolean> {
    const entry = this.burns.get(p.withdrawalId.toLowerCase());
    if (!entry) return false;
    return (
      entry.ref.toLowerCase() === p.shadowBurnRef.toLowerCase() &&
      entry.asset.toLowerCase() === p.asset.toLowerCase() &&
      entry.amount === p.amount
    );
  }

  // --- NonceChecker ---
  async isNonceUsed(owner: Address, nonce: bigint): Promise<boolean> {
    return this.usedNonces.has(`${owner.toLowerCase()}:${nonce}`);
  }
}
