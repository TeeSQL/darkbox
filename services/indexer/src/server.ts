import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { publicRoutes } from "./routes/public.js";
import { demoFaucetRoutes } from "./routes/demoFaucet.js";
import { internalRoutes } from "./routes/internal.js";
import { config } from "./config.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
    },
  });

  await app.register(sensible);

  await app.register(publicRoutes);
  await app.register(demoFaucetRoutes);
  await app.register(internalRoutes);

  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({
      error: e.message ?? "Internal server error",
    });
  });

  return app;
}

export async function startServer(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[indexer] listening on :${config.port}`);
}
