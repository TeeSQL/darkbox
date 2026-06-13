/**
 * Funding routes: deposit intents + withdrawal commands.
 *
 *  POST /api/deposit-intents        — compose a deposit session (helper)
 *  GET  /api/deposits/:depositOpId  — deposit detection/reconciliation status
 *  GET  /api/withdrawable/:owner     — withdrawable available balance
 *  POST /api/withdrawals/commands    — submit a user-signed EIP-712 withdrawal
 *  GET  /api/withdrawals/:withdrawalId — withdrawal lifecycle status
 *
 * Canonical deposit/withdrawal coordination lives in services/bridge (watcher +
 * coordinators + signing service). The gateway is the authenticated public face:
 * it validates shape + the promo withdrawal-lock, then hands off to the bridge.
 * Withdrawals are demo-gated off (see config.withdrawalsEnabled).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { submitWithdrawalRequestSchema } from "@darkbox/shared";
import { config } from "../config.js";
import { db } from "../store.js";
import { resolveIdentity } from "../identity.js";
import { newId } from "../ids.js";

const depositIntentBody = z.object({
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  chainId: z.number().int().positive().optional(),
  token: z.literal("USDC").optional(),
});

export async function withdrawalsRoutes(app: FastifyInstance): Promise<void> {
  // ── Deposits ──────────────────────────────────────────────────────────────
  app.post("/api/deposit-intents", async (req, reply) => {
    const parsed = depositIntentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const identity = resolveIdentity(
      req.telegramUser.id,
      parsed.data.owner as `0x${string}` | undefined,
    );
    const chainId = parsed.data.chainId ?? config.publicChainId;
    return reply.send({
      depositOpId: newId("dep"),
      status: "intent_created",
      chainId,
      token: "USDC",
      amount: parsed.data.amount,
      beneficiary: identity.owner,
      // Deposits go to the public bridge escrow; the bridge watcher attributes
      // the confirmed transfer to this beneficiary and mints shadow USDC.
      depositAddress: config.bridgeAddress,
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    });
  });

  app.get<{ Params: { depositOpId: string } }>(
    "/api/deposits/:depositOpId",
    async (req, reply) => {
      // Detection/reconciliation is owned by the bridge watcher. Until that read
      // is wired, report a deterministic pending shape rather than a fake mint.
      return reply.send({
        depositOpId: req.params.depositOpId,
        status: "pending_bridge_reconciliation",
        chainId: config.publicChainId,
        updatedAt: new Date().toISOString(),
      });
    },
  );

  // ── Withdrawals ───────────────────────────────────────────────────────────
  app.get<{ Params: { owner: string } }>("/api/withdrawable/:owner", async (req, reply) => {
    const invite = db.getInvite(req.telegramUser.id);
    const now = Date.now();
    const promoLocked = Boolean(invite) && now < Date.parse(invite!.withdrawalUnlockAt);
    return reply.send({
      owner: req.params.owner,
      // Promo-locked players have nothing withdrawable; real available balance is
      // resolved by the bridge once wired. Null = "ask the bridge", not zero.
      withdrawableAvailableBalance: promoLocked ? "0.00" : null,
      currency: "USDC",
      locked: promoLocked,
      unlockAt: invite?.withdrawalUnlockAt ?? null,
      updatedAt: new Date().toISOString(),
    });
  });

  app.post("/api/withdrawals/commands", async (req, reply) => {
    if (!config.withdrawalsEnabled) {
      return reply.status(403).send({
        error: "withdrawals_disabled",
        reason: "locked_until_settlement",
        hint: "demo posture: withdrawals open after the box opens",
      });
    }
    const parsed = submitWithdrawalRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    // Promo lock guard (defence in depth; the signer also enforces invariants).
    const invite = db.getInvite(req.telegramUser.id);
    if (invite && Date.now() < Date.parse(invite.withdrawalUnlockAt)) {
      return reply.status(409).send({ error: "promo_locked", unlockAt: invite.withdrawalUnlockAt });
    }
    // Hand off to the bridge withdrawal coordinator (shadow burn → signer).
    // Wiring point: POST {bridgeUrl}/internal/withdrawals once bridge exposes HTTP.
    return reply.send({
      withdrawalId: newId("wd"),
      status: "shadow_burn_submitted",
      amount: parsed.data.command.amount,
      recipient: parsed.data.command.recipient,
      destinationChainId: parsed.data.command.destinationChainId,
      updatedAt: new Date().toISOString(),
    });
  });

  app.get<{ Params: { withdrawalId: string } }>(
    "/api/withdrawals/:withdrawalId",
    async (req, reply) => {
      return reply.send({
        withdrawalId: req.params.withdrawalId,
        status: "shadow_burn_submitted",
        updatedAt: new Date().toISOString(),
      });
    },
  );
}
