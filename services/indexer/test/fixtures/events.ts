import type { NormalizedEvent } from "../../src/adapters/types.js";

const BASE_META = {
  chainId: 8453,
  blockNumber: 100n,
  blockTimestamp: 1_700_000_000n,
  txHash: "0xabc0000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
  logIndex: 0,
  contractAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
};

export function makeAgentRegisteredEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    adapter: "bridge",
    eventName: "AgentRegistered",
    decoded: {
      gameId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      agentId: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
      owner: "0xowner0000000000000000000000000000000001",
      shadowAccount: "0xshadow000000000000000000000000000000001",
      ensName: "alice.eth",
      instructionHash: "0x" + "ab".repeat(32),
      runtimeHash: "0x" + "cd".repeat(32),
      revealSaltHash: "0x" + "ef".repeat(32),
    },
    ...overrides,
  };
}

export function makeDepositReceivedEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    adapter: "bridge",
    eventName: "DepositReceived",
    decoded: {
      gameId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      owner: "0xowner0000000000000000000000000000000001",
      amount: 1000000n,
      beneficiary: "0xowner0000000000000000000000000000000001",
      depositRef: "0x" + "1a".repeat(32),
    },
    ...overrides,
  };
}

export function makeWithdrawalExecutedEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    adapter: "bridge",
    eventName: "WithdrawalExecuted",
    logIndex: 1,
    decoded: {
      gameId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      owner: "0xowner0000000000000000000000000000000001",
      amount: 500000n,
      recipient: "0xrecip0000000000000000000000000000000001",
      nonce: 1n,
      userCommandHash: "0x" + "2b".repeat(32),
      shadowBurnRef: "0x" + "3c".repeat(32),
    },
    ...overrides,
  };
}

export function makeShadowMintedEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    chainId: 1337,
    adapter: "shadow_bridge",
    eventName: "ShadowMinted",
    contractAddress: "0x2222222222222222222222222222222222222222",
    decoded: {
      depositOpId: "0x" + "1a".repeat(32),
      shadowAccount: "0xshadow000000000000000000000000000000001",
      amount: 1000000n,
    },
    ...overrides,
  };
}

export function makeMarketCreatedEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    chainId: 1337,
    adapter: "pm_factory",
    eventName: "MarketCreated",
    contractAddress: "0x3333333333333333333333333333333333333333",
    decoded: {
      gameId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      marketId: "0xmarket000000000000000000000000000000000000000000000000000000001",
      creator: "0xcreator0000000000000000000000000000001",
      market: "0xmarket0000000000000000000000000000000001",
      question: "Will ETH exceed $5000 by Dec 31?",
      metadataURI: "ipfs://QmXxx",
      closeTime: 1800000000n,
      resolveBy: 1800086400n,
      resolverType: 0,
    },
    ...overrides,
  };
}

export function makeFrontierDepositEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    chainId: 1337,
    adapter: "frontier",
    eventName: "Deposit",
    contractAddress: "0x4444444444444444444444444444444444444444",
    decoded: {
      positionId: 1n,
      owner: "0xowner0000000000000000000000000000000001",
      lower: 0,
      upper: 60,
      liquidity: 1000000n,
    },
    ...overrides,
  };
}

export function makeFrontierClaimEvent(
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    ...BASE_META,
    chainId: 1337,
    adapter: "frontier",
    eventName: "Claim",
    contractAddress: "0x4444444444444444444444444444444444444444",
    logIndex: 2,
    decoded: {
      positionId: 1n,
      proceeds1: 950000n,
    },
    ...overrides,
  };
}
