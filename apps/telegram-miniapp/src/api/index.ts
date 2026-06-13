/**
 * API layer entry point. Constructs the two backend clients from build-time env
 * and the platform adapter, so views import ready-to-use `gateway` / `indexer`
 * singletons and never touch base URLs, auth, or `fetch` directly.
 *
 *   import { gateway, indexer } from "../api";
 *   const me = await gateway.selfStatus();
 *   const board = await indexer.leaderboard();
 *
 * Env (Vite, inlined at build):
 *   VITE_GATEWAY_BASE_URL   authenticated player API (default http://127.0.0.1:8090)
 *   VITE_INDEXER_BASE_URL   public spectator API     (default http://127.0.0.1:8080)
 *   VITE_DEV_TELEGRAM_ID    dev-auth id when outside Telegram (web/local only)
 */

import { createGatewayClient } from "../gatewayClient.js";
import { createIndexerClient } from "./indexer.js";
import { getDevTelegramId, getInitData } from "../platform/telegram.js";

const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};

const gatewayBaseUrl = env.VITE_GATEWAY_BASE_URL ?? "http://127.0.0.1:8090";
const indexerBaseUrl = env.VITE_INDEXER_BASE_URL ?? "http://127.0.0.1:8080";

export const gateway = createGatewayClient({
  gatewayBaseUrl,
  publicBaseUrl: `${indexerBaseUrl.replace(/\/$/, "")}/public`,
  getInitData,
  devTelegramId: getDevTelegramId(),
});

export const indexer = createIndexerClient({ baseUrl: indexerBaseUrl });

export { GatewayError } from "../gatewayClient.js";
export { IndexerError } from "./indexer.js";
