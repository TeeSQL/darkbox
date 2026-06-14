import { FaucetCoordinator, InMemoryBridgeStore } from "@darkbox/bridge";
import { loadConfig } from "./config.js";
import { ViemFaucetMinter } from "./minter.js";
import { buildServer } from "./server.js";
import { runLoop } from "./worker.js";

/**
 * Faucet-mint-worker entrypoint (private-mesh CVM worker; mirrors services/bridge
 * and services/market-executor).
 *
 * Wires the durable FaucetCoordinator to a viem ShadowBridgeController minter,
 * starts the mesh-internal HTTP surface, and runs the drain loop forever. The
 * loop tolerates the hidden RPC being down at startup — it logs and retries,
 * never hard-exits.
 *
 * SECURITY: the coordinator private key lives ONLY in `cfg.coordinatorPrivateKey`
 * and is handed straight to viem. We log the derived coordinator ADDRESS (public)
 * and NEVER the key.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  const store = new InMemoryBridgeStore();
  const minter = new ViemFaucetMinter({
    rpcUrl: cfg.hiddenRpcUrl,
    chainId: cfg.hiddenChainId,
    controllerAddress: cfg.shadowBridgeControllerAddress,
    coordinatorPrivateKey: cfg.coordinatorPrivateKey,
    fromBlock: cfg.fromBlock,
  });
  const coordinator = new FaucetCoordinator(
    { gameId: cfg.gameId, amount: cfg.faucetAmount },
    store,
    minter,
  );

  // Safe to log: everything EXCEPT the private key.
  console.log("[faucet-mint-worker] starting", {
    hiddenChainId: cfg.hiddenChainId,
    hiddenRpcUrl: cfg.hiddenRpcUrl,
    shadowBridgeController: cfg.shadowBridgeControllerAddress,
    gameId: cfg.gameId,
    coordinator: minter.coordinatorAddress,
    faucetAmount: cfg.faucetAmount.toString(),
    pollIntervalMs: cfg.pollIntervalMs,
    port: cfg.port,
    meshAuth: cfg.meshToken ? "required" : cfg.allowInsecureDev ? "dev-open" : "refused",
  });
  if (!cfg.meshToken && !cfg.allowInsecureDev) {
    console.warn(
      "[faucet-mint-worker] MESH_TOKEN unset — internal endpoints will 503 until configured.",
    );
  }

  const app = buildServer({
    coordinator,
    store,
    meshToken: cfg.meshToken,
    allowInsecureDev: cfg.allowInsecureDev,
  });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  console.log(`[faucet-mint-worker] listening on :${cfg.port}`);

  const shutdown = () => {
    console.log("[faucet-mint-worker] shutting down");
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await runLoop({ coordinator, fetchLimit: cfg.fetchLimit }, cfg.pollIntervalMs);
}

main().catch((err) => {
  console.error("[faucet-mint-worker] fatal:", err);
  process.exit(1);
});
