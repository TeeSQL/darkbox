/**
 * Authenticated `/api/*` plugin.
 *
 * Every route registered here is gated by Telegram `initData` validation via an
 * `onRequest` hook. Because Fastify hooks are encapsulated, registering the child
 * route plugins INSIDE this plugin means they all inherit the auth gate — there
 * is no way to add an `/api/*` route that skips auth by construction.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, type TelegramUser } from "../auth/telegram.js";
import { invitesRoutes } from "./invites.js";
import { selfRoutes } from "./self.js";
import { registrationsRoutes } from "./registrations.js";
import { whispersRoutes } from "./whispers.js";
import { withdrawalsRoutes } from "./withdrawals.js";

declare module "fastify" {
  interface FastifyRequest {
    telegramUser: TelegramUser;
  }
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    const result = authenticate(req.headers as Record<string, unknown>);
    if (!result.ok || !result.user) {
      // 401 without echoing why in a way that aids probing; log the reason.
      req.log.warn({ reason: result.reason }, "auth rejected");
      return reply.status(401).send({ error: "unauthorized" });
    }
    if (result.dev) {
      req.log.warn("INSECURE dev auth in use (no bot token configured)");
    }
    req.telegramUser = result.user;
  });

  await app.register(selfRoutes);
  await app.register(invitesRoutes);
  await app.register(registrationsRoutes);
  await app.register(whispersRoutes);
  await app.register(withdrawalsRoutes);
}
