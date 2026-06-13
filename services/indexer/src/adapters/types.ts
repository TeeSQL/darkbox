export type AdapterName =
  | "bridge"
  | "shadow_bridge"
  | "frontier"
  | "pm_factory"
  | "pm_market";

export interface RawEventMeta {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  txHash: `0x${string}`;
  logIndex: number;
  contractAddress: `0x${string}`;
  adapter: AdapterName;
}

export interface NormalizedEvent<T = Record<string, unknown>> extends RawEventMeta {
  eventName: string;
  decoded: T;
}

// ─── Bridge events ────────────────────────────────────────────────────────────

export interface AgentRegisteredEvent {
  gameId: `0x${string}`;
  agentId: `0x${string}`;
  owner: `0x${string}`;
  shadowAccount: `0x${string}`;
  ensName: string;
  instructionHash: `0x${string}`;
  runtimeHash: `0x${string}`;
  revealSaltHash: `0x${string}`;
}

export interface DepositReceivedEvent {
  gameId: `0x${string}`;
  owner: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
  beneficiary: `0x${string}`;
  depositRef: `0x${string}`;
}

export interface WithdrawalExecutedEvent {
  gameId: `0x${string}`;
  owner: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
  recipient: `0x${string}`;
  nonce: bigint;
  userCommandHash: `0x${string}`;
  shadowBurnRef: `0x${string}`;
}

export interface EmergencyWithdrawalEvent {
  gameId: `0x${string}`;
  owner: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
  recipient: `0x${string}`;
  reason: `0x${string}`;
}

// ─── Shadow bridge events ────────────────────────────────────────────────────

export interface ShadowMintedEvent {
  depositOpId: `0x${string}`;
  shadowAccount: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
}

export interface ShadowBurnedEvent {
  withdrawalId: `0x${string}`;
  shadowAccount: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
}

// ─── Frontier CLOB events ────────────────────────────────────────────────────

export interface FrontierDepositEvent {
  positionId: bigint;
  owner: `0x${string}`;
  lower: number;
  upper: number;
  liquidity: bigint;
}

export interface FrontierClaimEvent {
  positionId: bigint;
  proceeds1: bigint;
}

export interface FrontierCancelEvent {
  positionId: bigint;
  proceeds1: bigint;
  principal0: bigint;
}

export interface FrontierIntervalFilledEvent {
  lowerTick: number;
  liquidity: bigint;
  proceeds1: bigint;
  clock: bigint;
}

export interface FrontierInternalCreditEvent {
  user: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
}

export interface FrontierInternalWithdrawEvent {
  user: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
}

export interface FrontierMakerFeeEvent {
  positionId: bigint;
  token: `0x${string}`;
  grossProceeds: bigint;
  fee: bigint;
  netProceeds: bigint;
}

export interface FrontierTakerFeeEvent {
  payer: `0x${string}`;
  token: `0x${string}`;
  grossInput: bigint;
  fee: bigint;
  totalPaid: bigint;
}

// ─── PM Factory events ────────────────────────────────────────────────────────

export interface MarketCreatedEvent {
  gameId: `0x${string}`;
  marketId: `0x${string}`;
  creator: `0x${string}`;
  market: `0x${string}`;
  question: string;
  metadataURI: string;
  closeTime: bigint;
  resolveBy: bigint;
  resolverType: number;
}

export interface BooksRegisteredEvent {
  marketId: `0x${string}`;
  yesBook: `0x${string}`;
  noBook: `0x${string}`;
  yesToken: `0x${string}`;
  noToken: `0x${string}`;
}

// ─── PM Market events ─────────────────────────────────────────────────────────

export interface MarketResolvedEvent {
  marketId: `0x${string}`;
  outcome: number; // 0=Unset 1=Yes 2=No 3=Invalid
  resolutionHash: `0x${string}`;
}

export interface MarketVoidedEvent {
  marketId: `0x${string}`;
  reason: string;
  evidenceHash: `0x${string}`;
}

export interface MarketStatusEvent {
  marketId: `0x${string}`;
}

export interface SplitEvent {
  marketId: `0x${string}`;
  caller: `0x${string}`;
  receiver: `0x${string}`;
  amount: bigint;
}

export interface JoinedEvent {
  marketId: `0x${string}`;
  caller: `0x${string}`;
  receiver: `0x${string}`;
  amount: bigint;
}

export interface RedeemedEvent {
  marketId: `0x${string}`;
  caller: `0x${string}`;
  receiver: `0x${string}`;
  outcome: number;
  amount: bigint;
}
