/**
 * Mesh-internal HTTP boundary for the faucet mint worker.
 *
 *   GET  /health
 *   GET  /internal/faucet/mints?state=pending&limit=N   list ledger records
 *   POST /internal/faucet/mints/:operationId/process    drive one record to minted
 *   POST /internal/faucet/mints/:operationId/retry      requeue a failed record
 *   POST /internal/faucet/grants/human                  enqueue a $5 human promo
 *   POST /internal/faucet/grants/daemon                  enqueue $5 daemon funding
 *
 * ALL routes except /health are sealed: reachable only on the private mesh, gated
 * by a shared secret (`x-mesh-token`). No token configured ⇒ fail closed (503),
 * unless ALLOW_INSECURE_DEV=true. The coordinator key is never exposed by any
 * route — these endpoints only manipulate the durable faucet ledger.
 */
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import {
  FaucetConflictError,
  type FaucetCoordinator,
} from "@darkbox/bridge";
import type { BridgeStore, FaucetMintRecord } from "@darkbox/bridge";
import { FaucetMintState } from "@darkbox/shared";
import { z } from "zod";
import type { Hex } from "viem";

export interface ServerDeps {
  coordinator: FaucetCoordinator;
  /** Read access to the ledger for the list/get endpoints. */
  store: BridgeStore;
  meshToken: string;
  allowInsecureDev: boolean;
}

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");
const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte value");

const humanGrantSchema = z.object({
  telegramId: z.string().min(1),
  inviteId: z.string().min(1),
  owner: addressSchema,
  shadowAccount: bytes32Schema,
});

const daemonGrantSchema = z.object({
  daemonId: z.string().min(1),
  daemonAddress: addressSchema,
  shadowAccount: bytes32Schema,
});

/** JSON-safe view of a ledger record (bigint `amount` → decimal string). */
export function serializeRecord(r: FaucetMintRecord): Record<string, unknown> {
  return { ...r, amount: r.amount.toString() };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });
  void app.register(sensible);

  app.get("/health", async () => ({
    ok: true,
    service: "faucet-mint-worker",
    meshAuth: deps.meshToken ? "required" : deps.allowInsecureDev ? "dev-open" : "refused",
  }));

  // Mesh-only gate: every non-health route requires the shared secret.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    if (!deps.meshToken) {
      if (deps.allowInsecureDev) return;
      return reply.status(503).send({ error: "mesh_auth_not_configured" });
    }
    const presented = (req.headers["x-mesh-token"] as string | undefined) ?? "";
    if (presented !== deps.meshToken) {
      req.log.warn("faucet endpoint rejected: bad mesh token");
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/internal/faucet/mints", async (req, reply) => {
    const q = req.query as { state?: string; limit?: string };
    const limit = q.limit ? Math.max(0, Number(q.limit)) : 100;
    let records: FaucetMintRecord[];
    if (q.state === FaucetMintState.Pending) {
      // Fast path: ordered pending queue straight from the coordinator.
      records = deps.coordinator.listPending(limit);
    } else {
      records = deps.store.listFaucetMints();
      if (q.state) records = records.filter((r) => r.state === q.state);
      records = records.slice(0, limit);
    }
    return reply.send({ mints: records.map(serializeRecord) });
  });

  app.post("/internal/faucet/mints/:operationId/process", async (req, reply) => {
    const { operationId } = req.params as { operationId: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(operationId)) {
      return reply.status(400).send({ error: "invalid_operation_id" });
    }
    if (!deps.store.getFaucetMint(operationId as Hex)) {
      return reply.status(404).send({ error: "unknown_operation_id" });
    }
    const record = await deps.coordinator.process(operationId as Hex);
    return reply.send({ mint: serializeRecord(record) });
  });

  app.post("/internal/faucet/mints/:operationId/retry", async (req, reply) => {
    const { operationId } = req.params as { operationId: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(operationId)) {
      return reply.status(400).send({ error: "invalid_operation_id" });
    }
    if (!deps.store.getFaucetMint(operationId as Hex)) {
      return reply.status(404).send({ error: "unknown_operation_id" });
    }
    const record = deps.coordinator.retry(operationId as Hex);
    return reply.send({ mint: serializeRecord(record) });
  });

  app.post("/internal/faucet/grants/human", async (req, reply) => {
    const parsed = humanGrantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const record = deps.coordinator.enqueueHumanPromo({
      telegramId: parsed.data.telegramId,
      inviteId: parsed.data.inviteId,
      owner: parsed.data.owner as Hex,
      shadowAccount: parsed.data.shadowAccount as Hex,
    });
    return reply.send({ mint: serializeRecord(record) });
  });

  app.post("/internal/faucet/grants/daemon", async (req, reply) => {
    const parsed = daemonGrantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    try {
      const record = deps.coordinator.enqueueDaemonFunding({
        daemonId: parsed.data.daemonId,
        daemonAddress: parsed.data.daemonAddress as Hex,
        shadowAccount: parsed.data.shadowAccount as Hex,
      });
      return reply.send({ mint: serializeRecord(record) });
    } catch (err) {
      if (err instanceof FaucetConflictError) {
        return reply.status(409).send({ error: "faucet_conflict", detail: err.message });
      }
      throw err;
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal server error" });
  });

  return app;
}
