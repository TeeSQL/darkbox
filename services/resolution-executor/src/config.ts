import type { Address, Hex } from "viem";

/**
 * Resolution-executor configuration (mirrors services/market-executor/src/config.ts).
 * Values come from environment / sealed secrets; `loadConfig` reads `process.env`
 * with sane defaults for everything EXCEPT secrets and chain-identifying
 * addresses, which are required.
 *
 * SECURITY: `coordinatorPrivateKey` is read from env only. It is NEVER logged,
 * echoed, or written to disk. Treat it like the bridge signer key.
 */
export interface ResolutionExecutorConfig {
  hiddenRpcUrl: string;
  hiddenChainId: number;
  /** DarkBoxMarketFactory address on the hidden chain (admin resolve entrypoint). */
  marketFactoryAddress: Address;
  /** Factory owner/coordinator key (the configured resolver). NEVER log this. */
  coordinatorPrivateKey: Hex;
  /** Indexer internal base URL, e.g. http://localhost:8080/internal (no trailing slash). */
  indexerInternalUrl: string;
  pollIntervalMs: number;
  /** Recorded as the acting principal on complete-resolution (#22 contract). */
  actorId: string;
}

function req(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolutionExecutorConfig {
  return {
    hiddenRpcUrl: env.HIDDEN_RPC_URL ?? "http://localhost:8545",
    hiddenChainId: Number(env.HIDDEN_CHAIN_ID ?? "88813"),
    marketFactoryAddress: req("MARKET_FACTORY_ADDRESS", env.MARKET_FACTORY_ADDRESS) as Address,
    coordinatorPrivateKey: req("COORDINATOR_PRIVATE_KEY", env.COORDINATOR_PRIVATE_KEY) as Hex,
    indexerInternalUrl: (env.INDEXER_INTERNAL_URL ?? "http://localhost:8080/internal").replace(
      /\/$/,
      "",
    ),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? "8000"),
    actorId: env.RESOLUTION_ACTOR_ID ?? "resolution-executor",
  };
}
