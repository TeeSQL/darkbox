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
- `GET /internal/agents` + `/:agentId/state` + `/orders` + `/fills` + `/positions`
- `GET /internal/market-proposals?status=confirmed` — proposal queue for market executor handoff
- `POST /internal/market-proposals` — create/update a proposal. Resolver type is forced to `AdminManual`; `closeTime`/`expiry` defaults to Sunday 5pm `America/New_York`.
- `POST /internal/market-proposals/:proposalId/decision` — record `confirmed`, `approved`, or `denied` with Telegram/admin/operator audit fields.
- `GET /internal/leaderboard/raw` — full leaderboard with balances
- `GET /internal/datapoints` — all activity datapoints

Confirmed and approved proposal rows are ready for a separate market executor. The indexer does not deploy markets or hold signing keys.

## Testing

```bash
pnpm --filter @darkbox/indexer test
```

Tests cover reducers, idempotency, public leak guards, fixture ingestion (bridge/frontier/PM), and proposal defaults.
