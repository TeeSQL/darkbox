# DarkBox API — implementation status (for Kristel / Nicolai)

Companion to the canonical contract in `docs/api/openapi.yaml`. The spec describes
the *intended* surface; this file says what is **wired today** vs **planned**, and
flags response-shape deltas, so the frontend doesn't build against vaporware.

Last reconciled: 2026-06-13 UTC (branch `dan/backend-security`).

Legend: ✅ implemented & tested · 🟡 implemented, integration pending · ⛔ planned, not built yet.

## Public spectator API — served by `darkbox-indexer` (`/public/*`)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /public/health` | ✅ | |
| `GET /public/game` | ✅ | |
| `GET /public/leaderboard` | ✅ | rank/PnL/ENS only; no balances/positions |
| `GET /public/markets` | ✅ | list |
| `GET /public/markets/{marketId}` | ⛔ | **in spec, NOT implemented** — indexer serves the list only. Don't depend on the single-market route yet. |
| `GET /public/activity` | ✅ | aggregate counters |
| `GET /public/reveal/status` | ✅ | |
| `GET /public/datapoints` | ✅ | **implemented, NOT in openapi.yaml** — please add to spec |
| `GET /public/timeseries` | ✅ | **implemented, NOT in openapi.yaml** — please add to spec |

## Authenticated player API — served by `darkbox-gateway` (`/api/*`)

All require validated Telegram `initData` (header `Authorization: tma <initData>`
or `X-Telegram-Init-Data`). Local dev without a bot token:
`ALLOW_INSECURE_DEV_AUTH=true` + header `X-Dev-Telegram-Id: <id>`.

| Endpoint | Status | Notes / shape deltas vs spec |
|----------|--------|------------------------------|
| `GET /api/self/status` | ✅ | extra fields added: `ownerIsSynthetic` (bool), `registrationFreezeAt`. `fundingStatus` ∈ `unfunded`\|`promo_funded` (spec said `funded`). `withdrawableAvailableBalance` may be `null` (= "ask the bridge", not zero) while bridge read is unwired. `inviteId` is `null` when no claim. |
| `POST /api/invites/claim` | ✅ | `claimStatus` ∈ `claimed`\|`already_claimed` (idempotent; second call returns the same `inviteId`, no double credit). Promo mint itself is the bridge's job (recorded here, surfaced via self-status). |
| `POST /api/registrations` | ✅ | adds `frozen` (bool). Rejects with `409 registration_frozen` after `REGISTRATION_FREEZE_AT`. |
| `POST /api/whispers/transcriptions` | ✅ | accepts `{ text }` (typed fallback) **or** audio (`telegramFileId`/`audioUrl`); audio proxies to `darkbox-transcriber` when `TRANSCRIBER_URL` is set, else `503 transcriber_not_configured`. |
| `GET /api/whispers/transcriptions/{id}` | ✅ | per-user isolation (others get `403`). |
| `POST /api/whispers/transcriptions/{id}/confirm` | ✅ | returns `instructionHash` + `commitmentPayload`. |
| `POST /api/deposit-intents` | 🟡 | returns a real intent shape (`depositAddress` = bridge escrow); confirmation/mint is the bridge watcher's job. |
| `GET /api/deposits/{id}` | 🟡 | returns `pending_bridge_reconciliation` until bridge HTTP is wired. |
| `GET /api/withdrawable/{owner}` | 🟡 | returns `0.00`/locked for promo; real available balance comes from the bridge once wired. |
| `POST /api/withdrawals/commands` | 🟡 | **demo-gated OFF** → `403 withdrawals_disabled` (locked until settlement). Validates EIP-712 shape + promo lock when enabled. |
| `GET /api/withdrawals/{id}` | 🟡 | lifecycle status; full flow needs bridge + isolated signer. |

## Out of scope for the frontend (unchanged from spec)

`/internal/*`, `/bridge/admin/*`, signer endpoints, raw orderbooks/fills/positions
pre-reveal, raw whisper audio/transcript retrieval, reveal export internals.

## Suggested spec edits (so codegen matches reality)

1. Add `/public/datapoints` and `/public/timeseries`.
2. Mark `/public/markets/{marketId}` as not-yet-implemented (or implement it).
3. Sync `/api/self/status`, `/api/invites/claim`, `/api/registrations` schemas
   with the deltas above (these match the live gateway).
