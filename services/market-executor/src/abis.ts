import { parseAbi } from "viem";

/**
 * Minimal, hand-written viem ABI fragments for the hidden-chain
 * `DarkBoxMarketFactory`. Hand-written on purpose (market spec §9 +
 * MarketTypes.sol): the executor must NOT depend on compiled Foundry artifacts.
 *
 * `createMarket` takes a single `CreateMarketParams` struct with a nested
 * `ResolverConfig`. Field order MUST match MarketTypes.sol exactly or the
 * calldata encoding is wrong:
 *   CreateMarketParams { gameId, question, description, metadataURI,
 *                        resolver, closeTime, resolveBy, creatorBond,
 *                        initialLiquidity }
 *   ResolverConfig    { resolverType (enum uint8), resolver, sourceId, data }
 *
 * Note: on-chain, `createMarket` pins the market resolver to AdminManual and the
 * factory owner regardless of the `resolver` we pass — but `_validate` still
 * reverts unless `resolver.resolverType == AdminManual`, so we must send it.
 */
export const marketFactoryAbi = parseAbi([
  "struct ResolverConfig { uint8 resolverType; address resolver; bytes32 sourceId; bytes data; }",
  "struct CreateMarketParams { bytes32 gameId; string question; string description; string metadataURI; ResolverConfig resolver; uint64 closeTime; uint64 resolveBy; uint256 creatorBond; uint256 initialLiquidity; }",
  "function createMarket(CreateMarketParams params) returns (bytes32 marketId, address market)",
  "function getBooks(bytes32 marketId) view returns (address yesBook, address noBook)",
  "function getMarket(bytes32 marketId) view returns (address market)",
  "event MarketCreated(bytes32 indexed gameId, bytes32 indexed marketId, address indexed creator, address market, string question, string metadataURI, uint64 closeTime, uint64 resolveBy, uint8 resolverType)",
  "event BooksRegistered(bytes32 indexed marketId, address indexed yesBook, address indexed noBook, address yesToken, address noToken)",
]);

/** Name-addressed event items for getLogs / receipt parsing (index-independent). */
export const marketCreatedEvent = parseAbi([
  "event MarketCreated(bytes32 indexed gameId, bytes32 indexed marketId, address indexed creator, address market, string question, string metadataURI, uint64 closeTime, uint64 resolveBy, uint8 resolverType)",
])[0];

export const booksRegisteredEvent = parseAbi([
  "event BooksRegistered(bytes32 indexed marketId, address indexed yesBook, address indexed noBook, address yesToken, address noToken)",
])[0];
