# darkbox-indexer

Canonical derived-state service. Serves the public and internal APIs and owns
the off-chain **identity registry** (telegram ↔ daemon name ↔ shadow account).

## Identity model

Identities are keyed by `shadowAccount` — the only attribute every participant
has. Each row carries a `daemonName` (always present, shown on leaderboards),
`source` (`human` | `spawned`), and nullable `telegramUserId` / `telegramHandle`
/ `ownerAddress` / `ensName`. Spawned agents have no telegram but still get a
daemon name. The name is generated once and never changes; collisions are
retried against the `daemon_name` UNIQUE constraint.

Schema lives in `sql/` and is applied on boot by the migration runner. With no
`DATABASE_URL`, the service uses an in-memory store (local dev / tests).

## API

Public (`/public`):
- `GET /public/health`
- `GET /public/leaderboard` — entries with `daemonName`, `ensName?`, equity, pnl, rank

Internal (`/internal`, guarded by `x-internal-token` when `INTERNAL_API_TOKEN` is set):
- `GET /internal/health`
- `POST /internal/identity` — register `{ shadowAccount, source, telegramUserId?, ... }`
- `GET /internal/identity/by-shadow/:shadowAccount`
- `GET /internal/identity/by-telegram/:telegramUserId`
- `GET /internal/leaderboard/raw`
- `POST /internal/leaderboard/snapshot` — upsert `{ agentId, shadowAccount, startingBalance, currentEquity, pnl }`

## Develop

```sh
pnpm --filter @darkbox/indexer start   # in-memory unless DATABASE_URL is set
pnpm --filter @darkbox/indexer test
```

See ../../docs/TECH_SPEC.md for the full service contract.
