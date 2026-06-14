import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { apiRoutes } from "./routes/api.js";
import { publicProxyRoutes } from "./routes/publicProxy.js";
import { demoFaucetProxyRoutes } from "./routes/demoFaucet.js";
import { config } from "./config.js";

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    bodyLimit: config.whisperMaxBytes,
  });

  await app.register(sensible);

  // Unauthenticated liveness probe.
  app.get("/health", async () => ({
    ok: true,
    service: "gateway",
    authMode: config.telegramBotToken
      ? "telegram"
      : config.allowInsecureDevAuth
        ? "insecure-dev"
        : "disabled",
    withdrawalsEnabled: config.withdrawalsEnabled,
  }));

  // Read-only public spectator data (indexer /public/*) over the single public
  // edge — unauthenticated, registered outside the auth gate.
  await app.register(publicProxyRoutes);

  // Telegram-authed public edge for the demo faucet. It is `/public/*` (outside
  // the `/api/*` auth gate) but runs its own initData check and forwards a
  // trusted `{ address }` + tg id to the indexer's mint endpoint.
  await app.register(demoFaucetProxyRoutes);

  // All authenticated player endpoints live under the encapsulated auth gate.
  await app.register(apiRoutes);

  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal server error" });
  });

  return app;
}

export async function startServer(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[gateway] listening on :${config.port}`);
}
