import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import {
  grantDemoFaucet,
  type DemoFaucetChain,
  type DemoFaucetGrant,
  type DemoFaucetStore,
} from "../src/demoFaucet/faucet.js";

const TOKEN = "0x6493548385F94860Ff686F9D863A9C6693BF0Bbb".toLowerCase() as Address;
const SIGNER = "0x7bc70000000000000000000000000000000000aa" as Address;
const AMOUNT = 5_000_000n;
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

// ─── In-memory store (mirrors the two unique constraints) ──────────────────────
class FakeStore implements DemoFaucetStore {
  rows: DemoFaucetGrant[] = [];

  async findGrant(address: string, tgId: string | null): Promise<DemoFaucetGrant | null> {
    return (
      this.rows.find(
        (r) => r.address === address || (tgId !== null && r.tgId === tgId),
      ) ?? null
    );
  }
  async countGrants(): Promise<number> {
    return this.rows.length;
  }
  async insertGrant(grant: DemoFaucetGrant): Promise<DemoFaucetGrant | null> {
    const clash = this.rows.some(
      (r) => r.address === grant.address || (grant.tgId !== null && r.tgId === grant.tgId),
    );
    if (clash) return null; // unique-violation analogue
    this.rows.push(grant);
    return grant;
  }
}

// ─── Fake chain (counts mints, configurable minter) ────────────────────────────
class FakeChain implements DemoFaucetChain {
  mintCalls: Array<{ to: Address; amount: bigint }> = [];
  constructor(private minter: Address = SIGNER, private nextTx: Hex = ("0x" + "ab".repeat(32)) as Hex) {}
  signerAddress(): Address {
    return SIGNER;
  }
  async readMinter(): Promise<Address> {
    return this.minter;
  }
  async mint(to: Address, amount: bigint): Promise<Hex> {
    this.mintCalls.push({ to, amount });
    return this.nextTx;
  }
}

function deps(store: DemoFaucetStore, chain: DemoFaucetChain, cap = 100) {
  return { chain, store, tokenAddress: TOKEN, amount: AMOUNT, globalCap: cap };
}

describe("grantDemoFaucet", () => {
  let store: FakeStore;
  let chain: FakeChain;
  beforeEach(() => {
    store = new FakeStore();
    chain = new FakeChain();
  });

  it("returns 503 demo_faucet_not_minter when signer is not the minter (no tx)", async () => {
    const wrongMinter = new FakeChain("0xdead0000000000000000000000000000000000ff" as Address);
    const res = await grantDemoFaucet(deps(store, wrongMinter), { address: WALLET_A, tgId: "111" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body["error"], "demo_faucet_not_minter");
    assert.equal(wrongMinter.mintCalls.length, 0, "must not broadcast a reverting tx");
    assert.equal(store.rows.length, 0);
  });

  it("first claim mints once and stores the grant", async () => {
    const res = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body["status"], "granted");
    assert.equal(res.body["amount"], "5000000");
    assert.equal(res.body["token"], TOKEN);
    assert.equal(res.body["recipient"], WALLET_A.toLowerCase());
    assert.equal(res.body["txHash"], "0x" + "ab".repeat(32));
    assert.equal(chain.mintCalls.length, 1);
    assert.equal(chain.mintCalls[0]!.amount, AMOUNT);
    assert.equal(store.rows.length, 1);
  });

  it("repeat claim (same wallet) returns existing grant and does NOT mint again", async () => {
    const first = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" });
    const second = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body["status"], "already_granted");
    assert.equal(second.body["txHash"], first.body["txHash"]);
    assert.equal(chain.mintCalls.length, 1, "second claim must not mint");
    assert.equal(store.rows.length, 1);
  });

  it("per-Telegram-user idempotency: same tg id, different wallet → already_granted", async () => {
    await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" });
    const res = await grantDemoFaucet(deps(store, chain), { address: WALLET_B, tgId: "111" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body["status"], "already_granted");
    assert.equal(chain.mintCalls.length, 1, "same tg user must not get a second mint");
  });

  it("per-wallet idempotency: same wallet, different tg id → already_granted", async () => {
    await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" });
    const res = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "222" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body["status"], "already_granted");
    assert.equal(chain.mintCalls.length, 1, "same wallet must not get a second mint");
  });

  it("rejects when the global cap is reached", async () => {
    const capped = deps(store, chain, 1);
    const ok = await grantDemoFaucet(capped, { address: WALLET_A, tgId: "111" });
    assert.equal(ok.statusCode, 200);
    const over = await grantDemoFaucet(capped, { address: WALLET_B, tgId: "222" });
    assert.equal(over.statusCode, 429);
    assert.equal(over.body["error"], "demo_faucet_cap_reached");
    assert.equal(chain.mintCalls.length, 1, "capped claim must not mint");
  });

  it("rejects an invalid address with 400 (no mint)", async () => {
    for (const bad of ["", "0x123", "not-an-address", "0xZZZ1111111111111111111111111111111111111"]) {
      const res = await grantDemoFaucet(deps(store, chain), { address: bad, tgId: "111" });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(res.body["error"], "invalid_address");
    }
    assert.equal(chain.mintCalls.length, 0);
    assert.equal(store.rows.length, 0);
  });

  it("works on the body-address-only path (no tg id) and stays per-wallet idempotent", async () => {
    const first = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: null });
    assert.equal(first.body["status"], "granted");
    const second = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: null });
    assert.equal(second.body["status"], "already_granted");
    assert.equal(chain.mintCalls.length, 1);
  });
});
