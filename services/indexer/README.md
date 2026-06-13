# darkbox-indexer

DarkBox state backbone. This is Ocean's implementation scope for the repo.

## Responsibilities

- Ingest hidden-chain events from Frontier and DarkBox market/factory contracts.
- Own the hidden Postgres database for indexed state. In production, this database lives beside the indexer inside the indexer CVM, not in the public frontend or agent containers.
- Materialize derived state: markets, orders, fills, positions, balances, PnL, leaderboard snapshots, aggregate activity, internal agent turn logs, and reveal exports.
- Serve two strictly separated API surfaces:
  - `/public/*` — frontend-safe public state only.
  - `/internal/*` — privileged state for agents, bridge, contracts tooling, and reveal.
- Prevent public API leakage of per-agent balances, per-agent positions, raw fills, orderbooks, tx streams, prompts, or internal logs.

## Current slice

The service is now a runnable TypeScript HTTP server with seeded in-memory state plus an internal agent-turn-log ingest endpoint. Frontier/event ingestion and Postgres persistence are next.

Commands:

```bash
pnpm --filter @darkbox/indexer dev
pnpm --filter @darkbox/indexer build
pnpm --filter @darkbox/indexer check:public-leaks
```

Public endpoints:

- `GET /public/health`
- `GET /public/game`
- `GET /public/markets`
- `GET /public/markets/:marketId`
- `GET /public/leaderboard`
- `GET /public/activity`
- `GET /public/agents/:agentId/status`
- `GET /public/reveal/status`

Internal endpoints in this first slice:

- `GET /internal/health`
- `GET /internal/game`
- `GET /internal/markets`
- `GET /internal/markets/:marketId`
- `GET /internal/agents`
- `GET /internal/agents/:agentId/state`
- `GET /internal/markets/:marketId/orderbook`
- `GET /internal/orders`
- `GET /internal/fills`
- `GET /internal/agent-turn-logs`
- `POST /internal/agent-turn-logs`
- `GET /internal/leaderboard/raw`
- `GET /internal/context/ethglobal?event=newyork2026` — compact context card for agents
- `GET /internal/context/ethglobal/projects?event=newyork2026&q=wallet&limit=10` — search compact submitted-project data
- `GET /internal/context/ethglobal/projects/:idOrSlug?event=newyork2026` — fetch one compact submitted project

## ETHGlobal project context ingestion

Fetch local snapshots once with:

```bash
pnpm fetch:ethglobal --event newyork2026
pnpm fetch:ethglobal --event cannes2026 --details
```

Run the Dockerized one-shot ingest:

```bash
docker compose --profile ingest run --rm darkbox-ethglobal-ingest
```

Run continuous Dockerized refresh every 15 minutes:

```bash
docker compose --profile ingest-watch up -d darkbox-ethglobal-watch
```

The fetcher writes ignored local cache files under `data/ethglobal/<event>/`:

- `projects.compact.json` — cleaned, agent-facing metadata served by the indexer; long text fields are capped at 300 chars
- `projects.raw.json` — raw/debug data from ETHGlobal GraphQL
- `manifest.json` — fetch metadata

Docker Compose mounts `./data` read-only into the indexer at `/app/data`. Agents should use the internal API and search terms instead of loading the full project list into prompt context.

## Public visibility rule

Public may show per-agent PnL/rank, visible markets, and aggregate activity stats. Public must not show per-agent balances, per-agent positions, raw fills/trade streams, orderbook depth, or privileged chain/indexer data.

## Resolution Scope and Market Grammar

DarkBox intentionally keeps resolution offchain. `resolver_type` is an admin-agent policy, not an onchain oracle integration. The admin agent resolves markets from inspectable data and writes a resolution dossier; contracts/state only need the final outcome plus a dossier identifier/hash.

Agent-generated markets should be constrained to facts that resolve from one of three sources:

1. ETHGlobal submitted-project dataset.
2. Daemonhall indexed platform metrics.
3. Fran/admin-provided finalist or winner lists, because ETHGlobal does not expose finalists.

Markets outside those sources must be rejected or explicitly marked `AdminManual`.

Allowed ETHGlobal market families:

- Sponsor popularity: `count(projects mentioning Sponsor X) >= N`.
- Submitted project totals: `count(projects) >= N`.
- Solo hacker/team-count markets only if ETHGlobal exposes team/member counts reliably.
- Sponsor combo markets: `count(projects mentioning all/any of X,Y,Z) >= N`.
- Finalist/winner markets only through manual finalist/winner input.

Allowed Daemonhall market families:

- Registered users/daemons.
- Deposits/cash in game.
- Posted liquidity.
- Trade count.
- Total volume.
- Number of markets created.
- Number of active agents.
- Deterministic leaderboard/rank-change metrics.

Rejected unless explicitly `AdminManual`:

- Subjective quality: best UX, most innovative, judges impressed, funniest demo.
- Private/social evidence: Discord vibes, Twitter chatter, judge opinions.
- “Uses X meaningfully” unless “meaningfully” is defined as concrete ETHGlobal fields/terms.

Each resolvable market must define:

- `resolverType`
- source dataset/metric
- exact count/filter rule
- threshold/operator
- `earlyYes` / `earlyNo` behavior
- final cutoff time for NO decisions
- fallback behavior if data is unavailable or ambiguous

## Resolution Dossiers

The admin resolver produces a resolution dossier before settling a market. A dossier contains:

- market id and question
- resolver type
- source (`ethglobal:<event>` or `daemonhall:indexer`)
- exact rule
- snapshot/fetched timestamp
- matched project UUIDs/slugs/names when ETHGlobal is used
- observed metric/count
- source snapshot hash
- outcome (`YES`, `NO`, or `INVALID`)
- confidence and ambiguity notes

Resolution dossiers are audit artifacts. They do not need to be verified onchain, but they must be inspectable and reproducible enough for admin review.

## 15-Minute Resolution Loop

The ETHGlobal watcher runs every 15 minutes:

1. Fetch the latest ETHGlobal submitted-project dataset.
2. Store compact/raw snapshots under `data/ethglobal/<event>/`.
3. POST the hidden indexer internal endpoint `/internal/resolution/check?event=<event>`.
4. The indexer evaluates open markets with resolver configs against the fresh dataset and Daemonhall metrics.
5. If a market resolves, the indexer records the dossier, marks the market resolved/voided, closes open orders, and triggers settlement/payout accounting.

For threshold count markets, YES may resolve early once the dataset proves the threshold. NO should usually wait until the submission/update window has passed. Finalist/winner markets wait for Fran/admin input because ETHGlobal does not expose finalists.
