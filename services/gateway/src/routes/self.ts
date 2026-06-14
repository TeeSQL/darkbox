/**
 * GET /api/self/status — the authenticated player's own safe state.
 *
 * This is the primary hydration endpoint for the Mini App. It composes
 * gateway-owned records (identity, invite, registration) into the self-status
 * shape. It exposes ONLY the player's own safe fields — never hidden positions,
 * orderbooks, other players' balances, or prompt preimages.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { db, deriveAgentId } from "../store.js";
import { resolveIdentity } from "../identity.js";

export async function selfRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/self/status", async (req) => {
    const telegramId = req.telegramUser.id;
    const identity = resolveIdentity(telegramId);
    const invite = db.getInvite(telegramId);
    const registration = db.getRegistration(telegramId);

    const now = Date.now();
    const unlockAt = invite ? Date.parse(invite.withdrawalUnlockAt) : 0;
    const promoLocked = Boolean(invite) && now < unlockAt;

    // Best-effort: the player's own indexer-sourced holdings (the CVM-reported
    // balance), keyed by shadow account. Reads the canonical /internal/balances
    // route (micro-USDC) and converts to a USDC decimal string. Never blocks
    // self/status on the indexer — on any failure we omit it and the promo stands.
    let shadowBalance: string | null = null;
    try {
      const base = config.indexerInternalUrl.replace(/\/$/, "");
      const res = await fetch(
        `${base}/internal/balances/${encodeURIComponent(identity.shadowAccount)}`,
        { signal: AbortSignal.timeout(2000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { currentBalanceMicro?: string };
        const micro = data.currentBalanceMicro;
        if (micro && /^\d+$/.test(micro)) {
          const m = BigInt(micro);
          shadowBalance = `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
        }
      }
    } catch {
      /* indexer unreachable → omit; the promo-funded view still applies */
    }

    return {
      owner: identity.owner,
      ownerIsSynthetic: identity.ownerIsSynthetic,
      telegramId,
      agentId: registration?.agentId ?? deriveAgentId(identity.shadowAccount),
      // The daemon's name as bound at registration (the UI's source of truth for
      // the display name). Null until the player seals/registers.
      agentName: registration?.agentName ?? null,
      ensName: registration?.ensName ?? null,
      registrationStatus: registration ? "registered" : "unregistered",
      // Funding status reflects whether the player has any credited source.
      // Real-deposit funding is reconciled by the bridge; here we surface the
      // promo claim. (Gateway is not the balance source of truth.)
      fundingStatus: invite ? "promo_funded" : "unfunded",
      enteredViaInvite: Boolean(invite),
      inviteId: invite?.inviteId ?? null,
      // Withdrawable balance is owned by the bridge; until that read is wired we
      // report the conservative locked-promo view rather than inventing a number.
      withdrawableAvailableBalance: promoLocked ? "0.00" : null,
      // Indexer-sourced holdings (USDC decimal; null when the indexer has no row
      // for this account yet, or was briefly unreachable).
      shadowBalance,
      instructionCommitmentHash: registration?.instructionHash ?? null,
      withdrawalLock: invite
        ? {
            locked: promoLocked,
            reason: promoLocked ? "promo_bonus_unlock" : null,
            unlockAt: invite.withdrawalUnlockAt,
          }
        : { locked: false, reason: null, unlockAt: null },
      registrationFreezeAt: config.registrationFreezeAt,
      updatedAt: new Date().toISOString(),
    };
  });
}
