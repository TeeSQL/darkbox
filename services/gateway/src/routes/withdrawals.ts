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
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { submitWithdrawalRequestSchema } from "@darkbox/shared";
import type { Hex } from "viem";
import { config } from "../config.js";
import { db, type DepositIntent } from "../store.js";
import { resolveIdentity } from "../identity.js";
import { newId } from "../ids.js";
import { upstreamJson } from "../upstream.js";

const depositIntentBody = z.object({
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  chainId: z.number().int().positive().optional(),
  token: z.literal("USDC").optional(),
});

const USDC_DECIMALS = 6n;
const USDC_SCALE = 1_000_000n; // 10 ** 6

/** Parse a USDC decimal string ("25", "25.5", "25.004213") to micro-USDC. */
function microFromUsdc(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const fracPadded = (frac + "000000").slice(0, Number(USDC_DECIMALS));
  return BigInt(whole) * USDC_SCALE + BigInt(fracPadded || "0");
}

/** Format micro-USDC back to a 6-decimal USDC string ("25004213" -> "25.004213"). */
function usdcFromMicro(micro: bigint): string {
  const whole = micro / USDC_SCALE;
  const frac = (micro % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0");
  return `${whole}.${frac}`;
}

/** bytes32 reconciliation tag bound to the order (deterministic, audit-friendly). */
function depositRefOf(parts: string): Hex {
  return `0x${createHash("sha256").update(parts).digest("hex")}` as Hex;
}

/**
 * Unique micro-USDC tag (0.001–0.009999) derived from the order ref. Added on
 * top of the requested amount so the exact transfer is self-identifying against
 * the shared escrow — the canonical key an operator/watcher uses to attribute a
 * deposit to this order.
 */
function amountTagMicro(depositRef: Hex): number {
  return (Number.parseInt(depositRef.slice(2, 10), 16) % 9000) + 1000;
}

/**
 * Best-effort read of the player's credited deposits from the indexer, keyed by
 * shadow account (micro-USDC). Returns null when the indexer can't answer — the
 * caller then reports a conservative "pending" rather than inventing a credit.
 */
async function readDepositedMicro(shadowAccount: string): Promise<bigint | null> {
  try {
    const res = await upstreamJson<{ totalDepositedMicro?: string; totalDeposited?: string }>(
      `${config.indexerInternalUrl}/internal/balances/${shadowAccount}`,
      { timeoutMs: 2500 },
    );
    const raw = res.totalDepositedMicro ?? res.totalDeposited;
    if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return 0n;
    return BigInt(String(raw));
  } catch {
    return null;
  }
}

/** Public-safe projection of a deposit order for its owner. */
function toDepositResponse(intent: DepositIntent) {
  return {
    depositOpId: intent.depositOpId,
    status: intent.status,
    chainId: intent.chainId,
    currency: intent.currency,
    amount: intent.amount,
    exactDepositAmount: intent.exactDepositAmount,
    amountTagMicroUsdc: intent.amountTagMicroUsdc,
    beneficiary: intent.owner,
    shadowAccount: intent.shadowAccount,
    depositAddress: intent.depositAddress,
    tokenAddress: intent.tokenAddress,
    depositRef: intent.depositRef,
    creditedAt: intent.creditedAt,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    updatedAt: new Date().toISOString(),
  };
}

export async function withdrawalsRoutes(app: FastifyInstance): Promise<void> {
  // ── Deposits ──────────────────────────────────────────────────────────────
  //
  // POST creates an AUTHED order bound to the player's resolved identity (owner +
  // shadowAccount — the account they keep control of) and a unique on-chain
  // reconciliation tag. The player sends the exact tagged amount to the shared
  // bridge escrow via Blink; the bridge watcher attributes + mints shadow USDC.
  // The gateway is not the balance source of truth — GET reconciles its own view
  // from the indexer's credited-balance read.
  app.post("/api/deposit-intents", async (req, reply) => {
    const parsed = depositIntentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const telegramId = req.telegramUser.id;
    const identity = resolveIdentity(
      telegramId,
      parsed.data.owner as `0x${string}` | undefined,
    );
    const chainId = parsed.data.chainId ?? config.publicChainId;

    const depositOpId = newId("dep");
    const depositRef = depositRefOf(
      `${depositOpId}:${config.gameId}:${identity.owner}:${parsed.data.amount}`,
    );
    const tagMicro = amountTagMicro(depositRef);
    const requestedMicro = microFromUsdc(parsed.data.amount);

    // The tagged exact amount must stay within the Blink signer cap, else the
    // signer rejects it. Reserve the max tag (9999 micro = $0.009999) as headroom.
    const capMicro = microFromUsdc(config.depositMaxUsdc);
    const maxRequestableMicro = capMicro - 10_000n; // cap - $0.01
    if (requestedMicro + BigInt(tagMicro) > capMicro) {
      return reply.status(400).send({
        error: "amount_exceeds_cap",
        cap: config.depositMaxUsdc,
        maxRequestable: usdcFromMicro(maxRequestableMicro > 0n ? maxRequestableMicro : 0n),
      });
    }

    const exactDepositAmount = usdcFromMicro(requestedMicro + BigInt(tagMicro));

    // Snapshot the reconciliation floor so a *new* credit is what flips the order
    // to "credited" — never the player's pre-existing balance. null = "couldn't
    // read", recorded as "unknown" so GET stays conservative.
    const baseline = await readDepositedMicro(identity.shadowAccount);

    const now = Date.now();
    const intent: DepositIntent = {
      depositOpId,
      telegramId,
      owner: identity.owner,
      shadowAccount: identity.shadowAccount,
      depositRef,
      chainId,
      currency: "USDC",
      amount: parsed.data.amount,
      exactDepositAmount,
      amountTagMicroUsdc: tagMicro,
      depositAddress: config.bridgeAddress,
      tokenAddress: config.usdcAddress,
      baselineDepositedMicro: baseline === null ? "unknown" : baseline.toString(),
      status: "intent_created",
      creditedAt: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.depositIntentTtlMs).toISOString(),
    };
    db.putDepositIntent(intent);
    req.log.info(
      { depositOpId, telegramId, shadowAccount: identity.shadowAccount },
      "deposit order created",
    );

    return reply.send(toDepositResponse(intent));
  });

  app.get<{ Params: { depositOpId: string } }>(
    "/api/deposits/:depositOpId",
    async (req, reply) => {
      const intent = db.getDepositIntent(req.params.depositOpId);
      // 404 (not 403) on a foreign/unknown order — never confirm another
      // player's order exists.
      if (!intent || intent.telegramId !== req.telegramUser.id) {
        return reply.status(404).send({ error: "deposit_not_found" });
      }

      // Terminal: stay credited once credited.
      if (intent.status === "credited") {
        return reply.send(toDepositResponse(intent));
      }

      const expired = Date.now() > Date.parse(intent.expiresAt);

      // Reconcile against the indexer's credited balance for this shadow account.
      // Credited iff a NEW deposit (delta over the creation baseline) covers the
      // requested amount. Unknown baseline / unreachable indexer => stay pending.
      const current = await readDepositedMicro(intent.shadowAccount);
      let credited = false;
      if (current !== null && intent.baselineDepositedMicro !== "unknown") {
        const delta = current - BigInt(intent.baselineDepositedMicro);
        credited = delta >= microFromUsdc(intent.amount);
      }

      if (credited) {
        intent.status = "credited";
        intent.creditedAt = new Date().toISOString();
      } else if (expired) {
        intent.status = "expired";
      } else {
        intent.status = "awaiting_settlement";
      }
      db.putDepositIntent(intent);

      return reply.send(toDepositResponse(intent));
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
