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

## 2026-06-14 — Mini App live integration: self/status name + indexer balance

Branch/PR: `ocean/frontend-live-integration` (PR #12, merged to main).

Wires the Daemon Hall Mini App to live data. The frontend half is already deployed
(static rsync) and degrades gracefully; the **gateway image must be rebuilt + the
CVM redeployed** for the two `self/status` additions to take effect:

- **`ghcr.io/teesql/darkbox-gateway`** — `GET /api/self/status` now also returns:
  - `agentName` + `ensName` — the daemon name bound at registration (was stored but
    never surfaced; the Mini App shows it as the daemon's name). Until redeploy, the
    Mini App falls back to a stable name derived from the server `agentId`.
  - `shadowBalance` — the player's indexer-sourced holdings (USDC decimal), read
    best-effort from `GET /internal/balances/:shadowAccount` (the same route PR #13
    added; reused, not duplicated) and converted from micro-USDC. Until redeploy, the
    Mini App shows the $5 promo credit.
- **indexer** — no new route needed beyond PR #13's `/internal/balances/:shadowAccount`.

Routing note: prod Caddy already forwards `/api/self/status` to the gateway TEE, and
`/public/*` was repointed from the dead `:3014` to the gateway TEE (live). No further
Caddy change needed.
