/**
 * Isolated signer HTTP boundary.
 *
 *   POST /internal/sign-withdrawal  (bridge-only, shared-secret gated)
 *   GET  /health
 *
 * The only way to obtain a signature is through the full SigningService check
 * set. There is NO route that exposes the key or signs arbitrary data.
 */
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import {
  decodeWithdrawCommand,
  SigningService,
  SignWithdrawalRejection,
  signWithdrawalRequestSchema,
  type SigningServiceDeps,
} from "@darkbox/shared";
import { config } from "./config.js";
import { buildSigningConfig, buildSigningDeps } from "./deps.js";

export function buildServer(depsOverride?: Partial<SigningServiceDeps>): FastifyInstance {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

  const deps = buildSigningDeps(depsOverride);
  const service = new SigningService(buildSigningConfig(), deps);

  void app.register(sensible);

  app.get("/health", async () => ({
    ok: true,
    service: "signer",
    signerAddress: deps.signer.address,
    bridgeAuth: config.bridgeToken ? "required" : config.allowInsecureDev ? "dev-open" : "refused",
  }));

  // Bridge-only auth: constant gate; the bridge presents the shared secret.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    if (!config.bridgeToken) {
      if (config.allowInsecureDev) return;
      return reply.status(503).send({ error: "signer_auth_not_configured" });
    }
    const presented = (req.headers["x-bridge-token"] as string | undefined) ?? "";
    if (presented !== config.bridgeToken) {
      req.log.warn("signer call rejected: bad bridge token");
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.post("/internal/sign-withdrawal", async (req, reply) => {
    const parsed = signWithdrawalRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const command = decodeWithdrawCommand(parsed.data.command);
    const now = Math.floor(Date.now() / 1000);
    try {
      const issued = await service.signWithdrawal(
        command,
        parsed.data.signature as `0x${string}`,
        parsed.data.shadowBurnRef as `0x${string}`,
        now,
      );
      // Serialize bigints in the payload to decimal strings for the wire.
      return reply.send({
        withdrawalId: issued.withdrawalId,
        payload: serializePayload(issued.payload as unknown as Record<string, unknown>),
        signature: issued.signature,
      });
    } catch (err) {
      if (err instanceof SignWithdrawalRejection) {
        req.log.warn({ reason: err.reason }, "withdrawal not authorized");
        return reply.status(422).send({ error: "rejected", reason: err.reason });
      }
      req.log.error({ err }, "signer error");
      return reply.status(500).send({ error: "signer_error" });
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal server error" });
  });

  return app;
}

function serializePayload(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}

export async function startServer(): Promise<void> {
  const app = buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[signer] listening on :${config.port}`);
}
