import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import {
  grantDemoFaucet,
  type DemoFaucetChain,
  type DemoFaucetGrant,
  type DemoFaucetStore,
} from "../src/demoFaucet/faucet.js";
import { checkInternalToken } from "../src/demoFaucet/internalAuth.js";

const TOKEN = "0x6493548385F94860Ff686F9D863A9C6693BF0Bbb".toLowerCase() as Address;
const SIGNER = "0x7bc70000000000000000000000000000000000aa" as Address;
const AMOUNT = 5_000_000n;
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

// ─── In-memory store (mirrors the two unique constraints + reserve/finalize) ───
// reserveGrant/finalizeGrant/releaseGrant bodies run synchronously (no internal
// await) so, like Postgres' unique index, exactly one of two concurrent
// reservations can win the race.
class FakeStore implements DemoFaucetStore {
  rows: DemoFaucetGrant[] = [];
  private nextId = 1;

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
  async reserveGrant(reservation: {
    address: string;
    tgId: string | null;
    amount: string;
  }): Promise<DemoFaucetGrant | null> {
    const clash = this.rows.some(
      (r) =>
        r.address === reservation.address ||
        (reservation.tgId !== null && r.tgId === reservation.tgId),
    );
    if (clash) return null; // unique-violation analogue
    const row: DemoFaucetGrant = {
      id: this.nextId++,
      address: reservation.address,
      tgId: reservation.tgId,
      txHash: null,
      amount: reservation.amount,
      status: "pending",
    };
    this.rows.push(row);
    return row;
  }
  async finalizeGrant(id: number, txHash: string): Promise<DemoFaucetGrant> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`reservation ${id} vanished`);
    row.txHash = txHash;
    row.status = "granted";
    return row;
  }
  async releaseGrant(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
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
  gasCalls: Array<{ to: Address; weiAmount: bigint }> = [];
  async fundGas(to: Address, weiAmount: bigint): Promise<Hex> {
    this.gasCalls.push({ to, weiAmount });
    return this.nextTx;
  }
}

function deps(store: DemoFaucetStore, chain: DemoFaucetChain, cap = 100) {
  return { chain, store, tokenAddress: TOKEN, amount: AMOUNT, globalCap: cap, gasWei: 50_000_000_000_000_000n };
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

  it("two concurrent same-wallet claims mint EXACTLY once (reserve-then-mint)", async () => {
    const [a, b] = await Promise.all([
      grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" }),
      grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" }),
    ]);
    assert.equal(chain.mintCalls.length, 1, "exactly one mint across both racers");
    assert.equal(store.rows.length, 1, "exactly one stored grant");
    // Exactly one racer is 'granted', the other replays 'already_granted'.
    const statuses = [a.body["status"], b.body["status"]].sort();
    assert.deepEqual(statuses, ["already_granted", "granted"]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
  });

  it("releases the reservation when the mint fails, so a retry can mint", async () => {
    const failing = new FakeChain();
    failing.mint = async () => {
      throw new Error("rpc boom");
    };
    await assert.rejects(
      grantDemoFaucet(deps(store, failing), { address: WALLET_A, tgId: "111" }),
      /rpc boom/,
    );
    assert.equal(store.rows.length, 0, "failed mint must not leave a dangling reservation");
    // Retry on a healthy chain now succeeds and mints.
    const retry = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: "111" });
    assert.equal(retry.body["status"], "granted");
    assert.equal(chain.mintCalls.length, 1);
  });

  it("works on the body-address-only path (no tg id) and stays per-wallet idempotent", async () => {
    const first = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: null });
    assert.equal(first.body["status"], "granted");
    const second = await grantDemoFaucet(deps(store, chain), { address: WALLET_A, tgId: null });
    assert.equal(second.body["status"], "already_granted");
    assert.equal(chain.mintCalls.length, 1);
  });
});

describe("checkInternalToken (internal-only gate)", () => {
  const TOKEN = "s3cr3t-mesh-token";

  it("accepts the correct token", () => {
    const res = checkInternalToken(TOKEN, TOKEN);
    assert.equal(res.ok, true);
    assert.equal(res.statusCode, undefined);
  });

  it("rejects a missing token with 401", () => {
    const res = checkInternalToken(undefined, TOKEN);
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body?.["error"], "unauthorized");
  });

  it("rejects a wrong token with 401", () => {
    const res = checkInternalToken("nope", TOKEN);
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body?.["error"], "unauthorized");
  });

  it("fails closed with 503 when no token is configured", () => {
    for (const presented of [undefined, "", "anything"]) {
      const res = checkInternalToken(presented, "");
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body?.["error"], "demo_faucet_internal_auth_not_configured");
    }
  });
});
