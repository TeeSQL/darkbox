# Pending CVM redeploy

> Action for whoever owns the core CVM / image builds (Dan / TeeSQL).

## 2026-06-14 — Gateway deposit-intent + reconciliation (Feed the daemon)

Branch/PR: `feat/gateway-deposit-intent-reconciliation`.

The gateway's deposit-order endpoints were stubs and are now functional, and the
indexer gained a balance read the gateway uses to reconcile. **Both images must
be rebuilt and the core CVM redeployed for this to take effect** — there is no CI
that does this automatically.

- **`ghcr.io/teesql/darkbox-gateway`** (built from `services/gateway/Dockerfile`)
  - `POST /api/deposit-intents` now persists an authed order bound to the
    player's `owner`+`shadowAccount` with a unique tagged `exactDepositAmount`.
  - `GET /api/deposits/:depositOpId` reconciles pending→credited from the indexer.
  - New env (optional): `DEPOSIT_MAX_USDC` (default `25`) — **must equal the
    miniapp Blink signer cap `BLINK_MAX_AMOUNT_USD`**; `USDC_ADDRESS`,
    `BRIDGE_ADDRESS`, `DEPOSIT_INTENT_TTL_MS` (all have sane defaults).
- **indexer** (core CVM) — new `GET /internal/balances/:shadowAccount`. Without
  this, the gateway degrades gracefully (orders stay `awaiting_settlement`).

Routing note: the prod Caddy `@gatewayApi` matcher already forwards
`/api/deposit-intents` and `/api/deposits/*` to the gateway TEE — no Caddy change
needed. Until the images are rebuilt, the deployed gateway returns the old stub
shape.

Frontend ("Feed the daemon" button + Blink popup) deploys separately via the
static rsync path to `darkbox-mic.repo.box` and is not part of these images.
