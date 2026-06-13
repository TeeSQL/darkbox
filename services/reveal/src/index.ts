/**
 * Reveal service (confidential plane). Exposes the bundle on demand to internal
 * callers only — it reads indexer INTERNAL state, so it must never be on
 * public_net. Publishing the bundle externally is a separate, deliberate step.
 */
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { config } from "./config.js";
import { HttpRevealSources } from "./sources.js";
import { buildRevealBundle } from "./bundle.js";

function sources() {
  return new HttpRevealSources(config.indexerInternalUrl, config.deploymentsDir);
}

function meta() {
  return {
    gameId: config.gameId,
    title: config.gameTitle,
    builtAt: new Date().toISOString(),
    revealPolicy: { includeInstructions: config.includeInstructions },
  };
}

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });
  await app.register(sensible);

  app.get("/health", async () => ({ ok: true, service: "reveal" }));

  app.get("/internal/reveal/bundle", async () => buildRevealBundle(sources(), meta()));

  app.get("/internal/reveal/timeline", async () => {
    const bundle = await buildRevealBundle(sources(), meta());
    return bundle.timeline;
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[reveal] listening on :${config.port}`);

  const shutdown = () => process.exit(0);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[reveal] fatal:", err);
  process.exit(1);
});
