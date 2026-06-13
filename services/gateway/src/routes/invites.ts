/**
 * POST /api/invites/claim — claim the $5 signup bonus.
 *
 * Rules (handover 05_MARKETING + 04_DAN_TODO #11):
 *  - one promo claim per Telegram identity (idempotent: re-claim returns the
 *    existing claim, never a second credit — anti-sybil at the identity layer);
 *  - credit is `promo_shadow` USDC, accounted separately from real deposits;
 *  - promo credits are withdrawal-locked until `promoUnlockAt`
 *    (Sunday 17:00 event-local).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db, type InviteClaim } from "../store.js";
import { resolveIdentity } from "../identity.js";
import { newId } from "../ids.js";

const claimBody = z.object({
  inviteCode: z.string().min(1).max(64).optional(),
  owner: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

function toResponse(claim: InviteClaim, shadowAccount: string, idempotent: boolean) {
  return {
    inviteId: claim.inviteId,
    claimStatus: idempotent ? "already_claimed" : "claimed",
    agentFundingCredit: {
      currency: claim.currency,
      amount: claim.amount,
      type: claim.fundingType,
    },
    withdrawalLock: { locked: true, unlockAt: claim.withdrawalUnlockAt },
    shadowAccount,
    updatedAt: claim.claimedAt,
  };
}

export async function invitesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/invites/claim", async (req, reply) => {
    const parsed = claimBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const telegramId = req.telegramUser.id;
    const identity = resolveIdentity(
      telegramId,
      parsed.data.owner as `0x${string}` | undefined,
    );

    // Idempotent: existing claim wins, no second credit.
    const existing = db.getInvite(telegramId);
    if (existing) {
      return reply.send(toResponse(existing, identity.shadowAccount, true));
    }

    const claim: InviteClaim = {
      inviteId: newId("invite"),
      telegramId,
      inviteCode: parsed.data.inviteCode ?? "self_serve",
      amount: config.promoAmount,
      currency: config.promoCurrency,
      fundingType: "promo_shadow",
      withdrawalUnlockAt: config.promoUnlockAt,
      claimedAt: new Date().toISOString(),
    };
    db.putInvite(claim);

    // NOTE: actual promo shadow-USDC mint is the bridge's job (separate promo
    // operation id). Gateway records the claim and exposes it via self-status;
    // the bridge mint is wired in services/bridge (mintShadow promo path).
    req.log.info({ inviteId: claim.inviteId, telegramId }, "promo claim recorded");

    return reply.send(toResponse(claim, identity.shadowAccount, false));
  });
}
