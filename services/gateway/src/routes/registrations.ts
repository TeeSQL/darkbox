/**
 * POST /api/registrations — bind the player's agent commitment before freeze.
 *
 * Binds agent name / ENS / instruction-commitment / reveal-salt / runtime hash
 * to the player's identity. Commitments FREEZE at `registrationFreezeAt`: after
 * that, no create/update (the commitment must appear unchanged in reveal
 * artifacts). The `DarkBoxBridge.registerAgent(...)` on-chain event is the
 * canonical commitment; this endpoint records the off-chain binding the UI needs
 * and is the source for the registration step of the reveal bundle.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db, deriveAgentId, type Registration } from "../store.js";
import { resolveIdentity } from "../identity.js";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);

const registrationBody = z.object({
  agentName: z.string().min(1).max(64),
  ensName: z.string().max(128).optional(),
  instructionHash: hex,
  revealSaltHash: hex.optional(),
  runtimeHash: hex.optional(),
});

export async function registrationsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/registrations", async (req, reply) => {
    const parsed = registrationBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }

    const frozen = Date.now() >= Date.parse(config.registrationFreezeAt);
    const telegramId = req.telegramUser.id;
    const existing = db.getRegistration(telegramId);

    if (frozen) {
      // After freeze: idempotent read of an existing registration is fine; any
      // create/update is refused so reveal commitments stay stable.
      if (existing) {
        return reply.send({
          registrationStatus: "registered",
          agentId: existing.agentId,
          commitmentRecorded: true,
          instructionHash: existing.instructionHash,
          registeredAt: existing.registeredAt,
          frozen: true,
        });
      }
      return reply.status(409).send({ error: "registration_frozen", freezeAt: config.registrationFreezeAt });
    }

    const identity = resolveIdentity(telegramId);
    const reg: Registration = {
      agentId: existing?.agentId ?? deriveAgentId(identity.shadowAccount),
      telegramId,
      agentName: parsed.data.agentName,
      ensName: parsed.data.ensName,
      instructionHash: parsed.data.instructionHash as `0x${string}`,
      revealSaltHash: parsed.data.revealSaltHash as `0x${string}` | undefined,
      runtimeHash: parsed.data.runtimeHash as `0x${string}` | undefined,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    };
    db.putRegistration(reg);
    req.log.info({ agentId: reg.agentId, telegramId }, "registration recorded");

    return reply.send({
      registrationStatus: "registered",
      agentId: reg.agentId,
      commitmentRecorded: true,
      instructionHash: reg.instructionHash,
      registeredAt: reg.registeredAt,
      frozen: false,
    });
  });
}
