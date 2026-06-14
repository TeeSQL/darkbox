import { loadConfig, marketTimes } from "./config.js";
import { ViemMarketFactoryClient } from "./factory.js";
import { HttpIndexerClient } from "./indexerClient.js";
import { runLoop, type ExecutorDeps } from "./executor.js";

/**
 * Market-executor entrypoint (mirrors the bridge/approval-bot worker shape).
 *
 * Loads config (secrets from sealed env), constructs the hidden-chain factory
 * client + indexer client, and runs the poll loop forever. The loop tolerates
 * the indexer/RPC being down at startup — it logs and retries, never hard-exits.
 *
 * SECURITY: the coordinator private key lives only in `cfg.coordinatorPrivateKey`
 * and is passed straight to viem. We log the derived coordinator ADDRESS (public)
 * and never the key.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  const factory = new ViemMarketFactoryClient({
    rpcUrl: cfg.hiddenRpcUrl,
    chainId: cfg.hiddenChainId,
    factoryAddress: cfg.marketFactoryAddress,
    coordinatorPrivateKey: cfg.coordinatorPrivateKey,
  });
  const indexer = new HttpIndexerClient(cfg.indexerInternalUrl);

  // Safe to log: everything EXCEPT the private key.
  console.log("[market-executor] starting", {
    hiddenChainId: cfg.hiddenChainId,
    hiddenRpcUrl: cfg.hiddenRpcUrl,
    marketFactory: cfg.marketFactoryAddress,
    gameId: cfg.gameId,
    coordinator: factory.coordinatorAddress,
    indexerInternalUrl: cfg.indexerInternalUrl,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  const deps: ExecutorDeps = {
    factory,
    indexer,
    coordinatorAddress: factory.coordinatorAddress,
    gameId: cfg.gameId,
    creatorBond: cfg.creatorBond,
    initialLiquidity: cfg.initialLiquidity,
    marketTimes: () => marketTimes(cfg),
  };

  await runLoop(deps, cfg.pollIntervalMs);
}

main().catch((err) => {
  console.error("[market-executor] fatal", err);
  process.exit(1);
});
