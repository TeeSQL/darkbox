/**
 * Gateway bootstrap for the live Daemon Hall UI (`public/flow.js`).
 *
 * `flow.js` is plain, unbundled JS served from `public/`, so it can't `import`
 * the typed client. This bundled module constructs the one shared
 * `GatewayClient` and hangs it on `window.DarkboxGateway` for flow.js to read
 * lazily (at call time, so script order never matters).
 *
 * Prod is same-origin: the Mini App is served from `darkbox-mic.repo.box`, where
 * Caddy proxies `/api/*` and `/public/*` to the gateway TEE. So the defaults are
 * relative — `gatewayBaseUrl: ""` → `/api/...`, `publicBaseUrl: "/public"`. Point
 * at a local stack by setting `VITE_GATEWAY_URL` / `VITE_PUBLIC_URL` at build time.
 */
import { createGatewayClient } from "./gatewayClient.js";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

const gateway = createGatewayClient({
  gatewayBaseUrl: env["VITE_GATEWAY_URL"] ?? "",
  publicBaseUrl: env["VITE_PUBLIC_URL"] ?? "/public",
  // initData defaults to window.Telegram.WebApp.initData inside the client.
  // Local dev against ALLOW_INSECURE_DEV_AUTH=true: set VITE_DEV_TELEGRAM_ID.
  devTelegramId: env["VITE_DEV_TELEGRAM_ID"] || undefined,
});

declare global {
  interface Window {
    DarkboxGateway?: ReturnType<typeof createGatewayClient>;
  }
}

window.DarkboxGateway = gateway;
window.dispatchEvent(new CustomEvent("darkbox:gateway-ready"));
