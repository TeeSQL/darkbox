import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMarketCloseTimeSeconds, parseMarketCloseTimeSeconds } from "../src/marketProposalDefaults.js";

describe("market proposal defaults", () => {
  it("defaults expiry to the upcoming Sunday at 5pm New York", () => {
    const closeTime = defaultMarketCloseTimeSeconds(new Date("2026-06-10T12:00:00Z"));
    assert.equal(new Date(closeTime * 1000).toISOString(), "2026-06-14T21:00:00.000Z");
  });

  it("rolls to the next Sunday after the current Sunday 5pm New York cutoff", () => {
    const closeTime = defaultMarketCloseTimeSeconds(new Date("2026-06-14T22:00:00Z"));
    assert.equal(new Date(closeTime * 1000).toISOString(), "2026-06-21T21:00:00.000Z");
  });

  it("accepts explicit epoch or ISO close times", () => {
    assert.equal(parseMarketCloseTimeSeconds(1781467200), 1781467200);
    assert.equal(parseMarketCloseTimeSeconds("2026-06-14T21:00:00Z"), 1781470800);
  });
});
