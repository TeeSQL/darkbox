# @darkbox/gateway — authenticated player BFF

The gateway is the **only** authenticated player surface (`/api/*`). It lives on
`public_net`, validates Telegram Mini App `initData` on every request, and
composes the internal indexer / bridge / transcriber services into the
player-facing API documented in `docs/api/openapi.yaml`.

It is intentionally **not** a balance/accounting source of truth:
- canonical money/accounting → `services/bridge` + hidden chain
- canonical derived public game state → `services/indexer` (`/public/*`)
- the gateway owns only coordination state: identities, invite claims,
  faucet handoff records, registration commitments, and whisper drafts.

## Security model

- Every `/api/*` route is gated by an encapsulated `onRequest` auth hook
  (`routes/api.ts`) — there is no way to register an `/api/*` route that skips
  auth by construction.
- Telegram `initData` is verified with HMAC-SHA256 per Telegram's WebApp spec,
  plus an `auth_date` freshness window (`auth/telegram.ts`).
- The bot token is read from env/secret and **never logged**.
- No `/internal/*`, hidden RPC, orderbook, position, other-user balance, or
  signer material is ever exposed.
- Whisper raw audio / draft transcripts are private; only the *confirmed*
  transcript's hash leaves the boundary (in registration).

### Dev auth fallback

For local runs without a bot token, set `ALLOW_INSECURE_DEV_AUTH=true` and pass
`X-Dev-Telegram-Id: <id>`. This is **refused** whenever a real token is set, and
the server logs a loud warning. Never enable it in prod.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | unauthenticated liveness |
| GET  | `/api/self/status` | player hydration (own safe state) |
| POST | `/api/invites/claim` | claim/enqueue the $5 promo faucet mint (idempotent, one per identity) |
| POST | `/api/registrations` | bind agent commitment before freeze |
| POST | `/api/whispers/transcriptions` | upload audio **or** typed text → draft |
| GET  | `/api/whispers/transcriptions/:id` | poll draft |
| POST | `/api/whispers/transcriptions/:id/confirm` | confirm/edit → instruction hash |
| POST | `/api/deposit-intents` | compose a deposit session |
| GET  | `/api/deposits/:id` | deposit reconciliation status |
| GET  | `/api/withdrawable/:owner` | withdrawable available balance |
| POST | `/api/withdrawals/commands` | submit signed EIP-712 withdrawal (demo-gated) |
| GET  | `/api/withdrawals/:id` | withdrawal lifecycle status |

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8090` | |
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | required for real auth; from secret |
| `TELEGRAM_AUTH_MAX_AGE_SEC` | `86400` | initData replay window |
| `ALLOW_INSECURE_DEV_AUTH` | `false` | local-only escape hatch |
| `INDEXER_INTERNAL_URL` | `http://localhost:8080` | |
| `BRIDGE_URL` | _(unset)_ | internal bridge URL; when set, `/api/invites/claim` posts the human promo faucet request to `/internal/faucet/human-promo` |
| `TRANSCRIBER_URL` | _(unset)_ | private transcriber; absent ⇒ typed fallback |
| `BRIDGE_ADDRESS` | `0x000…0` | deposit escrow address |
| `PROMO_AMOUNT` | `5.00` | signup bonus |
| `PROMO_UNLOCK_AT` | `2026-06-15T17:00:00.000Z` | legacy response field only; promo faucet credit is withdrawable once minted |
| `REGISTRATION_FREEZE_AT` | `2026-06-14T09:00:00.000Z` | commitment freeze |
| `WITHDRAWALS_ENABLED` | `false` | demo posture: off until settlement |

## Run

```bash
# typecheck + unit tests
pnpm --filter @darkbox/gateway typecheck
pnpm --filter @darkbox/gateway test

# local dev (insecure auth)
ALLOW_INSECURE_DEV_AUTH=true pnpm --filter @darkbox/gateway dev
curl -s localhost:8090/health
curl -s -XPOST localhost:8090/api/invites/claim -H 'X-Dev-Telegram-Id: 123'
```

## Promo faucet handoff

`POST /api/invites/claim` now creates a deterministic faucet operation id from
`GAME_ID + telegramId`, stores the invite claim with that id, and records a
handoff row. When `BRIDGE_URL` is configured, the gateway submits the handoff to
the bridge's internal faucet endpoint. The gateway never submits shadow-chain
mints and never needs a mint key.
