import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBillboardMessage } from "../src/index.js";

test("sanitize: trims and collapses whitespace", () => {
  const r = sanitizeBillboardMessage("  hello   world  ");
  assert.equal(r.ok, true);
  assert.equal(r.message, "hello world");
});

test("sanitize: truncates to max length", () => {
  const r = sanitizeBillboardMessage("a".repeat(400), 10);
  assert.equal(r.ok, true);
  assert.ok((r.message ?? "").length <= 10);
});

test("sanitize: rejects hidden-state leaks (mirrors the Python policy)", () => {
  const leaks = [
    "wallet 0x1234567890abcdef1234567890abcdef12345678",
    "shadow_account leak",
    "my private key is x",
    "dumping v0:book:m1:yes",
    "PORTFOLIO={cash:90}",
    "avgEntry 0.3 realizedPnl 4",
    "current_balance 991",
    'state {"size":"5","avgEntry":"0.3","price":"0.4"}',
    "0x" + "a".repeat(64),
  ];
  for (const msg of leaks) {
    const r = sanitizeBillboardMessage(msg);
    assert.equal(r.ok, false, `should reject: ${msg}`);
    assert.equal(r.reason, "hidden_state_leak");
  }
});

test("sanitize: a normal punchy ad passes", () => {
  assert.equal(sanitizeBillboardMessage("New Blink market live. Selling NO cheap.").ok, true);
});

test("sanitize: blank message is rejected", () => {
  assert.equal(sanitizeBillboardMessage("   ").ok, false);
});
