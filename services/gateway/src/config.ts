/**
 * Gateway (public BFF) configuration.
 *
 * The gateway is the ONLY authenticated player surface (`/api/*`). It lives on
 * `public_net`, validates Telegram `initData`, and composes the internal
 * indexer/bridge/transcriber services. It must never expose `/internal/*`,
 * hidden RPC, orderbooks, positions, balances, prompts, or signer material.
 */
export const config = {
  port: parseInt(process.env["PORT"] ?? "8090", 10),

  // Telegram Mini App auth. Token is read from env/secret, never logged.
  // When unset (local dev), auth runs in INSECURE dev mode (see auth/telegram.ts).
  telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
  // Reject initData older than this (replay-window guard).
  telegramAuthMaxAgeSec: parseInt(process.env["TELEGRAM_AUTH_MAX_AGE_SEC"] ?? "86400", 10),
  // Explicit opt-in for the insecure dev auth fallback. Must be false in prod.
  allowInsecureDevAuth: process.env["ALLOW_INSECURE_DEV_AUTH"] === "true",

  // Internal upstreams (reachable only from gateway; never proxied raw to client).
  indexerInternalUrl: process.env["INDEXER_INTERNAL_URL"] ?? "http://localhost:8080",
  bridgeUrl: process.env["BRIDGE_URL"] ?? "",
  transcriberUrl: process.env["TRANSCRIBER_URL"] ?? "",

  // Game framing.
  gameId: (process.env["GAME_ID"] ??
    "0x0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
  publicChainId: parseInt(process.env["PUBLIC_CHAIN_ID"] ?? "8453", 10),
  // Public escrow/bridge address used to compose deposit instructions. Defaults
  // to the canonical Base USDC bridge escrow so the gateway intent, the miniapp
  // Blink signer allowlist, and the Blink request all settle to the same place.
  bridgeAddress: (process.env["BRIDGE_ADDRESS"] ??
    "0x55E84818FCEDc3E892A22b46715Ee2B4A947E138") as `0x${string}`,
  // USDC token deposits settle in (Base USDC by default).
  usdcAddress: (process.env["USDC_ADDRESS"] ??
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`,
  // How long a deposit order stays open before it expires unmatched.
  depositIntentTtlMs: parseInt(process.env["DEPOSIT_INTENT_TTL_MS"] ?? "1800000", 10),
  // Max USDC a single deposit order may request. MUST equal the miniapp Blink
  // signer cap (BLINK_MAX_AMOUNT_USD) — the order's tagged exact amount has to
  // stay <= this or the signer rejects it. The reconciliation tag (≤ $0.01) is
  // reserved as headroom under this cap, so the effective max requestable is
  // `depositMaxUsdc - 0.01`.
  depositMaxUsdc: process.env["DEPOSIT_MAX_USDC"] ?? "25",

  // Team decision: withdrawals are LOCKED until settlement for the demo
  // (the isolated TEE signer is not the demo critical path). Default off.
  withdrawalsEnabled: process.env["WITHDRAWALS_ENABLED"] === "true",

  // Promo / $5 signup bonus.
  promoAmount: process.env["PROMO_AMOUNT"] ?? "5.00",
  promoCurrency: "USDC",
  // Promo credits cannot be withdrawn before this instant (Sunday 17:00 event-local).
  promoUnlockAt: process.env["PROMO_UNLOCK_AT"] ?? "2026-06-15T17:00:00.000Z",

  // Registration/commitment freeze: no new/updated commitments after this.
  registrationFreezeAt: process.env["REGISTRATION_FREEZE_AT"] ?? "2026-06-14T09:00:00.000Z",

  // Upload guards for the whisper flow.
  whisperMaxBytes: parseInt(process.env["WHISPER_MAX_BYTES"] ?? "5000000", 10),
  whisperMaxChars: parseInt(process.env["WHISPER_MAX_CHARS"] ?? "2000", 10),
};

export type Config = typeof config;
