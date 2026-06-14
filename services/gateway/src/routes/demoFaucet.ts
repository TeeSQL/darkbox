/**
 * POST /public/demo-faucet — Telegram-authed public edge for the demo faucet.
 *
 * The gateway is the single public surface but holds NO hidden RPC / minter key,
 * so the actual mint lives on the indexer. This route does the one thing only the
 * gateway can: validate Telegram `initData`, resolve the caller's trading address,
 * and forward a trusted `{ address }` + `x-telegram-id` to the indexer's
 * POST /public/demo-faucet, returning its response verbatim.
 *
 * It is registered OUTSIDE the `/api/*` auth gate (it is `/public/*`), so it runs
 * its own `authenticate()` check — a valid Telegram session is required, which is
 * also what yields the tg id used for the per-Telegram-user guardrail downstream.
 *
 * Recipient = body `{ address }` ONLY — a caller-supplied, validated 0x+40hex
 * trading wallet (the wallet the miniapp connects before calling this). There is
 * deliberately NO fallback to the player's synthetic identity owner: that address
 * is non-controllable, so minting $5 there would be unusable AND would burn a cap
 * slot. A missing/invalid address is a hard 400.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { authenticate } from "../auth/telegram.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function demoFaucetProxyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/public/demo-faucet", async (req, reply) => {
    const auth = authenticate(req.headers as Record<string, unknown>);
    if (!auth.ok || !auth.user) {
      req.log.warn({ reason: auth.reason }, "demo faucet auth rejected");
      return reply.status(401).send({ error: "unauthorized" });
    }
    const tgId = auth.user.id;

    // Recipient: the caller MUST supply a valid 0x trading wallet. No fallback —
    // see the module header for why minting to a synthetic owner is wrong.
    const body = (req.body ?? {}) as { address?: unknown };
    if (typeof body.address !== "string" || !ADDRESS_RE.test(body.address.trim())) {
      return reply.status(400).send({ error: "invalid_address" });
    }
    const address = body.address.trim();

    const base = config.indexerInternalUrl.replace(/\/$/, "");
    const target = `${base}/public/demo-faucet`;
    try {
      const upstream = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Trusted internal hop: the indexer keys its per-tg guardrail on this.
          "x-telegram-id": tgId,
        },
        body: JSON.stringify({ address }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await upstream.text();
      return reply
        .status(upstream.status)
        .header("content-type", upstream.headers.get("content-type") ?? "application/json")
        .send(text);
    } catch (err) {
      req.log.error({ err, target }, "demo faucet proxy upstream failed");
      return reply.status(502).send({ error: "indexer_unavailable" });
    }
  });
}
