import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { whisperRoutes } from "./routes.js";
import { config } from "./config.js";

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    // Allow base64 audio payloads up to ~1.4x the raw cap.
    bodyLimit: Math.ceil(config.maxAudioBytes * 1.4) + 4096,
  });

  await app.register(sensible);

  app.get("/health", async () => ({ ok: true, service: "transcriber", sttMode: config.sttMode }));

  await app.register(whisperRoutes);

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
  console.log(`[transcriber] listening on :${config.port} (stt=${config.sttMode})`);
}
