import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

/**
 * Read-only public proxy.
 *
 * The gateway is the only public edge of the mesh, so the indexer's public
 * spectator routes (`/public/*` — leaderboard, markets, activity) are surfaced
 * here alongside the authenticated `/api/*`. This lets the Mini App and the admin
 * panel read "what's happening" from the single public gateway URL without the
 * indexer ever being exposed directly.
 *
 * Hard boundary: ONLY `/public/*` is proxied. `/internal/*` (and anything else) is
 * never reachable through this route, so privileged indexer data can't leak out.
 * No auth — `/public/*` is public-by-design (no hidden positions/orderbooks).
 */
export async function publicProxyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/public/*", async (req, reply) => {
    // Fastify only routes `/public/...` here, but assert it so a future matcher
    // change can never turn this into an open proxy onto `/internal/*`.
    if (!req.url.startsWith("/public/")) {
      return reply.status(404).send({ error: "not_found" });
    }

    // `indexerInternalUrl` is the indexer base (no path suffix); `/public/*` lives
    // at its root. `req.url` already starts with `/public/` and carries the query.
    const base = config.indexerInternalUrl.replace(/\/$/, "");
    const target = `${base}${req.url}`;

    try {
      const upstream = await fetch(target, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      const body = await upstream.text();
      return reply
        .status(upstream.status)
        .header("content-type", upstream.headers.get("content-type") ?? "application/json")
        .send(body);
    } catch (err) {
      req.log.error({ err, target }, "public proxy upstream failed");
      return reply.status(502).send({ error: "indexer_unavailable" });
    }
  });
}
