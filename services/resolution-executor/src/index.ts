import { loadConfig } from "./config.js";
import { HttpDecisionSource } from "./decisionSource.js";
import { runLoop, type ExecutorDeps } from "./executor.js";
import { ViemMarketResolver } from "./resolver.js";

/**
 * Resolution-executor entrypoint (mirrors the bridge / market-executor worker
 * shape). A private-mesh CVM worker that EXECUTES already-approved admin market
 * resolutions on-chain. It does NOT decide outcomes — it only executes the
 * explicit decisions surfaced by the decision source.
 *
 * Loads config (secrets from sealed env), constructs the hidden-chain resolver
 * client + the decision source, and runs the poll loop forever. The loop
 * tolerates the indexer/RPC being down at startup — it logs and retries, never
 * hard-exits.
 *
 * SECURITY: the coordinator private key lives only in `cfg.coordinatorPrivateKey`
 * and is passed straight to viem. We log the derived coordinator ADDRESS (public)
 * and never the key.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  const resolver = new ViemMarketResolver({
    rpcUrl: cfg.hiddenRpcUrl,
    chainId: cfg.hiddenChainId,
    factoryAddress: cfg.marketFactoryAddress,
    coordinatorPrivateKey: cfg.coordinatorPrivateKey,
  });
  const source = new HttpDecisionSource({
    internalUrl: cfg.indexerInternalUrl,
    actorId: cfg.actorId,
  });

  // Safe to log: everything EXCEPT the private key.
  console.log("[resolution-executor] starting", {
    hiddenChainId: cfg.hiddenChainId,
    hiddenRpcUrl: cfg.hiddenRpcUrl,
    marketFactory: cfg.marketFactoryAddress,
    coordinator: resolver.coordinatorAddress,
    indexerInternalUrl: cfg.indexerInternalUrl,
    actorId: cfg.actorId,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  const deps: ExecutorDeps = { resolver, source };
  await runLoop(deps, cfg.pollIntervalMs);
}

main().catch((err) => {
  console.error("[resolution-executor] fatal", err);
  process.exit(1);
});
