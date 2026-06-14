import { parseAbi } from "viem";

/**
 * Minimal, hand-written viem ABI fragments for the hidden-chain market
 * contracts. Hand-written on purpose (market spec §8/§9 + MarketTypes.sol): the
 * executor must NOT depend on compiled Foundry artifacts.
 *
 * Resolution is FACTORY-gated. The market's own `resolve`/`voidMarket` are
 * `onlyFactory`; the only admin entrypoints are on `DarkBoxMarketFactory`:
 *
 *   resolveMarket(bytes32 marketId, uint8 outcome, bytes32 resolutionHash)
 *     -> market.resolve(outcome, resolutionHash)   // Yes/No only (reverts on Invalid)
 *   voidMarket(bytes32 marketId, string reason, bytes32 evidenceHash)
 *     -> market.voidMarket(reason, evidenceHash)    // resolves the market to Invalid
 *   closeMarket(bytes32 marketId)
 *     -> market.close()                             // Active/Paused -> Closed (no outcome)
 *
 * The factory enforces auth: msg.sender must be the factory `owner` or the
 * market's configured `resolver` (pinned to AdminManual + owner at creation).
 *
 * `Outcome` enum (MarketTypes.sol): Unset=0, Yes=1, No=2, Invalid=3.
 */
export const marketFactoryAbi = parseAbi([
  "function resolveMarket(bytes32 marketId, uint8 outcome, bytes32 resolutionHash)",
  "function voidMarket(bytes32 marketId, string reason, bytes32 evidenceHash)",
  "function closeMarket(bytes32 marketId)",
  "function getMarket(bytes32 marketId) view returns (address market)",
]);

/**
 * Read-only view of a single market, used for the on-chain idempotency check.
 *
 * `MarketStatus` enum (MarketTypes.sol): Draft=0, Active=1, Paused=2, Closed=3,
 * Resolved=4, Voided=5. A market that already reads Resolved or Voided must
 * never be resolved again.
 */
export const binaryMarketAbi = parseAbi([
  "function status() view returns (uint8)",
  "function resolvedOutcome() view returns (uint8)",
  "function marketId() view returns (bytes32)",
  "event MarketResolved(bytes32 indexed marketId, uint8 outcome, bytes32 resolutionHash)",
  "event MarketVoided(bytes32 indexed marketId, string reason, bytes32 evidenceHash)",
]);

/**
 * Standalone, name-addressed event items for `getLogs` idempotency scans
 * (mirrors services/faucet-mint-worker/src/abis.ts `shadowMintedEvent`). The
 * market emits these on `DarkBoxBinaryMarket`, keyed by the indexed `marketId`,
 * so the executor can recover the tx hash of an already-applied resolution
 * instead of sending (and reverting on) a second one.
 */
export const marketResolvedEvent = parseAbi([
  "event MarketResolved(bytes32 indexed marketId, uint8 outcome, bytes32 resolutionHash)",
])[0];

export const marketVoidedEvent = parseAbi([
  "event MarketVoided(bytes32 indexed marketId, string reason, bytes32 evidenceHash)",
])[0];
