# darkbox-indexer

Real TypeScript service. See `../../docs/TECH_SPEC.md` for the full spec.

## Running locally (without Docker)

```bash
# Requires Postgres at DATABASE_URL
export DATABASE_URL=postgres://darkbox:darkbox_dev_only@localhost:5432/darkbox
export HIDDEN_RPC_URL=http://localhost:8545

pnpm --filter @darkbox/indexer dev
```

## Running against the hidden node

```bash
export HIDDEN_RPC_URL=http://<hidden-node-host>:8545
export DATABASE_URL=postgres://...
export BRIDGE_ADDRESS=0x...
export SHADOW_BRIDGE_CONTROLLER_ADDRESS=0x...
export MARKET_FACTORY_ADDRESS=0x...
export GAME_ID=0x...
pnpm --filter @darkbox/indexer dev
```

## Endpoints

- `GET /public/health` — liveness check
- `GET /public/game` — aggregate game counters
- `GET /public/markets` — all markets (public safe)
- `GET /public/markets/:marketId` — single market
- `GET /public/leaderboard` — ranked PnL leaderboard (no balances)
- `GET /public/activity` — aggregate activity counters
- `GET /public/timeseries?metric=total_trades` — time series datapoints
- `GET /public/agents/:agentId/status` — agent registration status (no balances)
- `GET /public/reveal/status` — reveal state placeholder

- `GET /internal/health` — liveness check
- `GET /internal/cursors` — per-adapter block cursors
- `GET /internal/raw-events` — raw stored events
- `GET /internal/markets` + `/:marketId` + `/:marketId/orderbook`
- `GET /internal/markets/default-expiry` — next Sunday 5pm `America/New_York` expiry helper
- `POST /internal/markets/close-expired` — audited worker-compatible expiry close
- `POST /internal/markets/:marketId/close` — audited early close by `admin` or `ocean_operator`
- `POST /internal/markets/:marketId/prepare-resolution` — admin-only final outcome confirmation; returns signer handoff intent, does not sign or broadcast
- `POST /internal/markets/:marketId/complete-resolution` — records externally executed tx hash
- `GET /internal/markets/:marketId/lifecycle-actions` — complete operator audit trail
- `GET /internal/agents` + `/:agentId/state` + `/orders` + `/fills` + `/positions`
- `GET /internal/market-proposals?status=confirmed` — proposal queue for market executor handoff
- `POST /internal/market-proposals` — create/update a proposal. Resolver type is forced to `AdminManual`; `closeTime`/`expiry` defaults to Sunday 5pm `America/New_York`.
- `POST /internal/market-proposals/:proposalId/decision` — record `confirmed`, `approved`, or `denied` with Telegram/admin/operator audit fields.
- `GET /internal/leaderboard/raw` — full leaderboard with balances
- `GET /internal/datapoints` — all activity datapoints

Confirmed and approved proposal rows are ready for a separate market executor. The indexer does not deploy markets or hold signing keys.

## Market closing / resolution operator flow

Markets carry both legacy public fields (`close_time`, `status`, `resolved_outcome`) and the offchain lifecycle fields added in migration `005_market_lifecycle_resolution.sql`: `expires_at`, `lifecycle_status`, `closed_at`, `resolved_at`, `outcome`, `evidence`, `resolution_source`, tx hashes, action ids, and actor ids.

Default expiry is the upcoming Sunday at 5pm `America/New_York`; after that cutoff on Sunday, the helper returns the following Sunday. The indexer loop runs `closeExpiredMarkets` periodically when `MARKET_LIFECYCLE_ENABLED` is not `false`, using `MARKET_LIFECYCLE_INTERVAL_MS` as its cadence.

Early close is allowed only for `actorRole=admin` or `actorRole=ocean_operator`. Resolution preparation is stricter: `prepare-resolution` requires `actorRole=admin`, `confirmed=true`, an explicit `outcome`, `evidence`, and `source`. It moves the market to `resolution_pending` and returns an `onchainIntent` object for DarkDan's signer/executor to consume. This branch intentionally contains no private keys and performs no real deploy or transaction broadcast.

CLI examples:

```bash
pnpm --filter @darkbox/indexer lifecycle default-expiry --from=2026-06-14T18:00:00Z
pnpm --filter @darkbox/indexer lifecycle close-expired
pnpm --filter @darkbox/indexer lifecycle close --market-id=0x... --actor-id=ocean:dan --actor-role=ocean_operator --reason="early admin close"
pnpm --filter @darkbox/indexer lifecycle prepare-resolution --market-id=0x... --actor-id=admin:fran --actor-role=admin --outcome=Yes --evidence="reviewed finalist announcement" --source="DarkBox admin" --confirmed=true
pnpm --filter @darkbox/indexer lifecycle complete-resolution --market-id=0x... --actor-id=ocean:dan --actor-role=ocean_operator --tx-hash=0x...
```

## Testing

```bash
pnpm --filter @darkbox/indexer test
```

Tests cover reducers, idempotency, market lifecycle, public leak guards, fixture ingestion (bridge/frontier/PM), and proposal defaults.
