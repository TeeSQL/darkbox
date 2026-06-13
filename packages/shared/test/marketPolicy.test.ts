import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMarket,
  normalizeQuestion,
  validateMarket,
  type MarketCandidate,
} from "../src/marketPolicy.js";

const base = (over: Partial<MarketCandidate>): MarketCandidate => ({
  question: "Will at least 10 projects mention Base?",
  resolverType: "ExternalAttested",
  closeTime: 2_000_000_000,
  resolveBy: 2_000_100_000,
  metadataURI: "ipfs://m",
  gameEndsAt: 2_000_200_000,
  ...over,
});

test("normalizeQuestion lowercases, collapses space, strips trailing punctuation", () => {
  assert.equal(normalizeQuestion('  Will  X   WIN??  '), "will x win");
  // normalized equality is what duplicate detection relies on
  assert.equal(normalizeQuestion("Will X win?"), normalizeQuestion("will   x WIN"));
});

test("objective ethglobal metric is resolvable with a dossier", () => {
  const r = validateMarket(base({ question: "Will at least 10 projects mention Base?" }));
  assert.equal(r.ok, true);
  assert.equal(r.classification.family, "ethglobal_metric");
  assert.equal(r.dossier?.source, "ethglobal");
  assert.equal(r.dossier?.comparator, ">=");
  assert.equal(r.dossier?.threshold, 10);
});

test("objective darkbox metric (volume) maps to indexer source", () => {
  const r = validateMarket(
    base({ question: "Will total in-game volume exceed 1,000 USDC?" }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.classification.family, "darkbox_metric");
  assert.equal(r.dossier?.metric, "total_volume_usdc");
  assert.equal(r.dossier?.comparator, ">");
  assert.equal(r.dossier?.threshold, 1000);
});

test("subjective market is rejected unless AdminManual", () => {
  const rejected = validateMarket(base({ question: "Which project has the best UX?" }));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.includes("subjective_requires_admin"));

  const allowed = validateMarket(
    base({ question: "Which project has the best UX?", resolverType: "AdminManual" }),
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.classification.family, "admin_manual");
});

test("objective resolver with no metric family is rejected", () => {
  const r = validateMarket(base({ question: "Will it rain during the hackathon?" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("unresolvable_no_family"));
});

test("structural rules: empty / too-long / missing metadata / close after game end", () => {
  assert.ok(validateMarket(base({ question: "" })).errors.includes("empty_question"));
  assert.ok(validateMarket(base({ question: "x".repeat(250) })).errors.includes("question_too_long"));
  assert.ok(validateMarket(base({ metadataURI: "" })).errors.includes("missing_metadata"));
  assert.ok(
    validateMarket(base({ closeTime: 2_000_300_000 })).errors.includes("close_after_game_end"),
  );
  assert.ok(
    validateMarket(base({ resolveBy: 1_999_000_000 })).errors.includes("resolve_by_before_close"),
  );
});

test("classify is pure and AdminManual is always allowed even if subjective", () => {
  const c = classifyMarket("funniest demo", "AdminManual");
  assert.equal(c.resolvable, true);
  assert.equal(c.subjective, true); // flagged, but allowed under admin
});
