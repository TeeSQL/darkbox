import { parseAbi } from "viem";

export const bridgeAbi = parseAbi([
  "event AgentRegistered(bytes32 indexed gameId, bytes32 indexed agentId, address indexed owner, bytes32 shadowAccount, string ensName, bytes32 instructionHash, bytes32 runtimeHash, bytes32 revealSaltHash)",
  "event DepositReceived(bytes32 indexed gameId, address indexed owner, address indexed beneficiary, uint256 amount, bytes32 depositRef)",
  "event WithdrawalExecuted(bytes32 indexed gameId, address indexed owner, address indexed recipient, uint256 amount, uint256 nonce, bytes32 userCommandHash, bytes32 shadowBurnRef)",
  "event EmergencyWithdrawal(bytes32 indexed gameId, address indexed owner, address indexed recipient, uint256 amount, bytes32 reason)",
]);

export const shadowBridgeAbi = parseAbi([
  "event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, uint256 amount)",
  "event ShadowBurned(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, uint256 amount)",
]);

export const frontierBookAbi = parseAbi([
  "event Deposit(uint256 indexed positionId, address indexed owner, int24 lower, int24 upper, uint128 liquidity)",
  "event Claim(uint256 indexed positionId, uint256 proceeds1)",
  "event Cancel(uint256 indexed positionId, uint256 proceeds1, uint256 principal0)",
  "event IntervalFilled(int24 indexed lowerTick, uint128 liquidity, uint256 proceeds1, uint64 clock)",
  "event RunFilled(int24 indexed fromLevel, int24 toBoundary, uint256 startSize, int256 slopePerLevel, uint64 clock)",
  "event Requote(uint256 indexed positionId, int24 lower, int24 upper, uint128 liquidity)",
  "event PositionTransferred(uint256 indexed positionId, address indexed from, address indexed to)",
  "event InternalCredit(address indexed user, uint256 amount0, uint256 amount1)",
  "event InternalWithdraw(address indexed user, uint256 amount0, uint256 amount1)",
  "event MakerFee(uint256 indexed positionId, address indexed token, uint256 grossProceeds, uint256 fee, uint256 netProceeds, uint64 clock)",
  "event TakerFee(address indexed payer, address indexed token, uint256 grossInput, uint256 fee, uint256 totalPaid, uint64 clock)",
]);

export const pmFactoryAbi = parseAbi([
  "event MarketCreated(bytes32 indexed gameId, bytes32 indexed marketId, address indexed creator, address market, string question, string metadataURI, uint64 closeTime, uint64 resolveBy, uint8 resolverType)",
  "event BooksRegistered(bytes32 indexed marketId, address indexed yesBook, address indexed noBook, address yesToken, address noToken)",
  "event CreatorBondLocked(bytes32 indexed marketId, address indexed creator, uint256 amount)",
  "event CreatorBondReturned(bytes32 indexed marketId, address indexed creator, uint256 amount)",
  "event CreatorBondSlashed(bytes32 indexed marketId, address indexed creator, uint256 amount, string reason)",
]);

export const pmMarketAbi = parseAbi([
  "event MarketActivated(bytes32 indexed marketId)",
  "event MarketPaused(bytes32 indexed marketId, string reason)",
  "event MarketResumed(bytes32 indexed marketId)",
  "event MarketClosed(bytes32 indexed marketId)",
  "event MarketResolved(bytes32 indexed marketId, uint8 outcome, bytes32 resolutionHash)",
  "event MarketVoided(bytes32 indexed marketId, string reason, bytes32 evidenceHash)",
  "event Split(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount)",
  "event Joined(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount)",
  "event Redeemed(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint8 outcome, uint256 amount)",
]);
