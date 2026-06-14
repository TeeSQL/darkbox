/**
 * POST /public/demo-faucet — direct ERC20 sUSDC demo credit.
 *
 * Hosted on the indexer because this is where the three hard requirements all
 * live: fresh-chain RPC (HIDDEN_RPC_URL = localhost:8545 on the core), a
 * persistent Postgres DB for idempotency, and a CVM env that can hold the sealed
 * minter key. The gateway is the public edge and proxies POST /public/demo-faucet
 * here (it lives on public_net and intentionally has no hidden RPC / key).
 *
 * Recipient resolution: the gateway validates Telegram initData and forwards the
 * tg id as `x-telegram-id` plus the resolved trading address in the JSON body.
 * The body `{ address }` is re-validated here (defence in depth); the tg id keys
 * the per-Telegram-user guardrail.
 *
 * Internal-only: this privileged mint route is gated by a shared sealed token
 * (`x-internal-token` / INTERNAL_FAUCET_TOKEN, mirroring the faucet-mint-worker
 * mesh-token pattern). Only the gateway hop carries it; anything missing/wrong is
 * refused, so the route is un-hittable directly even if `/public` were exposed.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createDbStore } from "../demoFaucet/store.js";
import { createViemChain } from "../demoFaucet/chain.js";
import { grantDemoFaucet, type DemoFaucetChain } from "../demoFaucet/faucet.js";
import { checkInternalToken } from "../demoFaucet/internalAuth.js";
import type { Address } from "viem";

// Lazily built so a missing key/address doesn't crash indexer boot — the
// endpoint just reports not-configured.
let cachedChain: DemoFaucetChain | null = null;

function resolveChain(): DemoFaucetChain | null {
  if (cachedChain) return cachedChain;
  if (!config.demoFaucetMinterKey || !config.syntheticUsdcAddress) return null;
  try {
    cachedChain = createViemChain({
      rpcUrl: config.hiddenRpcUrl,
      chainId: config.hiddenChainId,
      minterKey: config.demoFaucetMinterKey,
      tokenAddress: config.syntheticUsdcAddress as Address,
    });
    return cachedChain;
  } catch {
    return null;
  }
}

export async function demoFaucetRoutes(app: FastifyInstance): Promise<void> {
  app.post("/public/demo-faucet", async (req, reply) => {
    // Internal-only gate (defense-in-depth): only the gateway hop, carrying the
    // shared sealed token, may reach this mint route — never a direct caller.
    const presented = req.headers["x-internal-token"];
    const auth = checkInternalToken(
      typeof presented === "string" ? presented : undefined,
      config.internalFaucetToken,
    );
    if (!auth.ok) {
      req.log.warn("demo faucet: internal token rejected");
      return reply.status(auth.statusCode!).send(auth.body);
    }

    const chain = resolveChain();
    if (!chain) {
      req.log.error("demo faucet: not configured (missing minter key or sUSDC address)");
      return reply.status(503).send({ error: "demo_faucet_not_configured" });
    }

    const body = (req.body ?? {}) as { address?: unknown; tgId?: unknown };
    const headerTgId = req.headers["x-telegram-id"];
    const tgId =
      (typeof headerTgId === "string" && headerTgId) ||
      (typeof body.tgId === "string" && body.tgId) ||
      null;
    const address = typeof body.address === "string" ? body.address : undefined;

    const result = await grantDemoFaucet(
      {
        chain,
        store: createDbStore(),
        tokenAddress: config.syntheticUsdcAddress as Address,
        amount: BigInt(config.demoFaucetAmount),
        globalCap: config.demoFaucetGlobalCap,
        gasWei: BigInt(config.demoFaucetGasWei),
        log: (obj, msg) => req.log.info(obj, msg),
      },
      { address, tgId },
    );

    return reply.status(result.statusCode).send(result.body);
  });
}
