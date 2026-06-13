# 03 — DarkBox Service Map

Date: 2026-06-13 UTC  
Repo: `/home/xiko/darkbox`

This file answers: what runs where, what is public, what is private, and what external systems each component depends on.

## Service boundary overview

DarkBox has three planes:

### 1) Public plane

User/spectator-facing. It must never expose hidden chain state.

Services:

- `darkbox-frontend`
- `darkbox-telegram-miniapp`
- public-safe indexer routes: `/public/*`
- narrow public-safe API routes for invite/deposit/withdrawal/whisper flows

Allowed data:

- public game state
- market metadata
- leaderboard rank/PnL only
- aggregate activity stats
- reveal status
- authenticated user's own registration/funding/commitment status

Forbidden data:

- hidden RPC
- `/internal/*` indexer data
- orderbooks
- raw trades/fills
- positions
- per-agent balances except authenticated safe self-status if explicitly designed
- prompts, transcripts, raw audio, reasoning traces
- bridge/signer/admin secrets

### 2) Hidden/confidential plane

Private game runtime. This is the thing that should map into CVM/TEE deployment over time.

Services:

- `darkbox-node`
- `darkbox-db`
- `darkbox-indexer` core/internal side
- `darkbox-agents`
- `darkbox-bridge` coordinator side
- `darkbox-transcriber`
- `darkbox-reveal`
- future `darkbox-signer`

Allowed data:

- hidden chain RPC
- indexed orderbooks/fills/positions/balances
- agent instructions and action logs
- shadow mint/burn accounting
- whisper audio/transcript drafts
- reveal bundle data

### 3) Egress plane

Services that need internet or public-chain access. Keep this list small.

Services needing egress:

- `darkbox-bridge` — Base/Arc RPCs, public escrow events, withdrawals, rebalancing later.
- `darkbox-ens` — ENS writes and provider access.
- `darkbox-reveal` — optional bundle publishing.
- `darkbox-agents` — model provider calls if Venice/current provider is called directly from agents.
- `darkbox-transcriber` — STT provider if not local/in-TEE transcription.
- `darkbox-ethglobal-ingest` / `darkbox-ethglobal-watch` — ETHGlobal GraphQL/API fetches.
- `darkbox-telegram-miniapp` — Telegram/Blink if running bot/server mode.

## Docker network map

Current `docker-compose.yml` defines:

### `hidden_net`

```yaml
networks:
  hidden_net:
    internal: true
```

Meaning: Docker-internal network, not reachable from outside Compose.

Use for:

- `darkbox-node:8545`
- `darkbox-db:5432`
- `darkbox-indexer:8080/internal`
- agent/indexer/bridge/reveal private calls
- transcriber private storage/API when added

Current attached services:

- `darkbox-node`
- `darkbox-db`
- `darkbox-ethglobal-watch`
- `darkbox-indexer`
- `darkbox-agents`
- `darkbox-bridge`
- `darkbox-reveal`

Important: `darkbox-indexer` is dual-homed to `hidden_net` and `public_net`. That is acceptable for local MVP only if public/internal route filtering remains tested. Long-term, split an `indexer-public-proxy` if risk grows.

### `public_net`

Public-facing network.

Current attached services:

- `darkbox-indexer`
- `darkbox-frontend`

Expected future attached services:

- `darkbox-telegram-miniapp`
- public API gateway/BFF if added

Important: public services should call only `http://darkbox-indexer:8080/public` or a safe API gateway. They should not call hidden node or internal indexer routes.

### `egress_net`

Outbound/internet/provider network.

Current attached services:

- `darkbox-ethglobal-ingest`
- `darkbox-ethglobal-watch`
- `darkbox-bridge`
- `darkbox-ens`
- `darkbox-reveal`

Expected future attached services if needed:

- `darkbox-agents` for Venice/model calls, unless model calls are proxied through a controlled internal provider.
- `darkbox-transcriber` if using external STT.
- `darkbox-telegram-miniapp` if it runs Telegram webhook/Blink server.

## Runtime service map

### `darkbox-node`

Purpose: hidden EVM chain.

Current status:

- Compose service exists.
- `infra/node/Dockerfile` and README are placeholders.
- No confirmed real Reth/Geth/Anvil/Frontier runtime yet.

Network:

- `hidden_net` only.
- Exposes `8545` to other containers, not to host/public.

Dependencies:

- Hidden chain client image.
- Frontier/orderbook contracts deployed inside it.
- DarkBox shadow contracts deployed inside it.

Must not:

- publish `ports:` to host
- be reachable from frontend/Mini App
- be used as frontend query source

### `darkbox-db`

Purpose: Postgres for hidden indexed state.

Current status:

- Compose service exists with Postgres 16 Alpine.
- Indexer currently appears seeded/in-memory; Postgres persistence is not fully wired.

Network:

- `hidden_net` only.

Data:

- markets, orders, fills, positions, balances, PnL, leaderboard snapshots, agent logs, reveal prep.

CVM note:

- In production, DB should live beside the indexer inside the confidential boundary.

### `darkbox-indexer`

Purpose: canonical derived state and visibility boundary.

Current status:

- Real TypeScript HTTP server.
- Real Dockerfile.
- Seeded in-memory state.
- Public/internal route split exists.
- ETHGlobal context endpoints exist.
- Internal agent-turn-log ingest endpoint exists.
- Frontier/event ingestion and Postgres persistence are still next steps.

Network:

- `hidden_net`
- `public_net`

Env:

- `HIDDEN_RPC_URL=http://darkbox-node:8545`
- `DATABASE_URL=postgres://darkbox:darkbox_dev_only@darkbox-db:5432/darkbox`
- `DATA_DIR=/app/data`
- `ETHGLOBAL_EVENT_SLUG=newyork2026`

Public endpoints documented in current README:

- `GET /public/health`
- `GET /public/game`
- `GET /public/markets`
- `GET /public/markets/:marketId`
- `GET /public/leaderboard`
- `GET /public/activity`
- `GET /public/agents/:agentId/status`
- `GET /public/reveal/status`

Internal endpoints documented in current README:

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
- `GET /internal/context/ethglobal?event=newyork2026`
- `GET /internal/context/ethglobal/projects?event=newyork2026&q=wallet&limit=10`
- `GET /internal/context/ethglobal/projects/:idOrSlug?event=newyork2026`

Must enforce:

- public routes never return orderbook/fills/positions/balances/prompts/internal logs.
- agents use constrained internal observations rather than raw DB or arbitrary web.

### `darkbox-agents`

Purpose: autonomous trading runtime.

Current status:

- Real TypeScript package.
- Strategy demos: random and Venice.
- Validator exists for turn JSON and basic market/order constraints.
- Turn logs can write hash-first NDJSON and/or post to indexer internal API.
- Dockerfile is currently placeholder, not real runtime.

Network:

- `hidden_net` in current compose.
- Add `egress_net` only if agents directly call Venice/model provider.

Env:

- `INDEXER_INTERNAL_URL=http://darkbox-indexer:8080/internal`
- `HIDDEN_RPC_URL=http://darkbox-node:8545`
- `VENICE_API_KEY` if using Venice strategy.
- optional `AGENT_TURN_LOG_DIR`.

Commands:

- `pnpm --filter @darkbox/agents demo:random`
- `pnpm --filter @darkbox/agents demo:venice`
- `pnpm --filter @darkbox/agents noise:random`
- `pnpm --filter @darkbox/agents noise:venice`

Must not:

- message outward during play
- call arbitrary URLs
- bypass indexer visibility policy
- leak prompts/reasoning publicly

### `darkbox-bridge`

Purpose: deposit watcher, shadow mint coordinator, withdrawal coordinator, emergency path.

Current status:

- Service README/spec exists.
- Compose placeholder exists.
- No real service package observed.
- Solidity contracts exist separately.

Network:

- `hidden_net`
- `egress_net`

External dependencies:

- Base RPC
- Arc RPC
- USDC contract addresses
- deployed public bridge addresses
- hidden RPC
- future signer service

Responsibilities:

- detect direct USDC transfers and explicit deposit calls
- normalize idempotent deposit operation IDs
- resolve owner -> shadow account
- submit `mintShadow` on hidden/shadow controller
- validate user withdrawal command
- submit `burnForWithdrawal`
- ask isolated signer for public withdrawal authorization
- maintain reconciliation/admin-only endpoints

Must not:

- hold final withdrawal signer key if avoidable
- double-credit deposits
- release public USDC before shadow burn/lock
- liquidate positions to satisfy withdrawals

### Future `darkbox-signer`

Purpose: isolated signing-service authorization for withdrawals.

Current status:

- Not implemented.
- Explicitly needed because current withdrawal signer/key custody path is insecure/incomplete.

Network:

- Hidden/confidential network only.
- Bridge may call it; public frontend must not.

CVM priority: very high.

Responsibilities:

- hold signer key in TEE/CVM/dedicated secret boundary
- verify user command signature
- verify owner/shadow mapping
- verify shadow burn/lock event
- verify nonce/deadline/amount/recipient/destination
- sign exactly one public withdrawal authorization

### `darkbox-transcriber`

Purpose: private whisper/audio transcription into confirmed agent instructions.

Current status:

- README/spec exists.
- No runnable service/package/Dockerfile currently observed.
- Not in current compose.

Network:

- Should be `hidden_net`.
- Add `egress_net` only if using external STT provider.
- Public clients should reach it only through a narrow proxy route.

CVM priority: very high.

Endpoints from spec:

- `POST /api/whispers/transcriptions`
- `GET /api/whispers/transcriptions/:whisperId`
- `POST /api/whispers/transcriptions/:whisperId/confirm`

Must not:

- expose raw whispers/transcripts publicly
- commit draft provider output without user confirmation
- store provider keys in frontend/Mini App
- treat spoken instructions as infrastructure commands

### `darkbox-frontend`

Purpose: public web app.

Current status:

- Placeholder service directory.
- Placeholder Dockerfile.
- Compose service publishes host port `3000:3000`.

Network:

- `public_net` only.

Env:

- `PUBLIC_INDEXER_URL=http://darkbox-indexer:8080/public`

Must not:

- call hidden RPC
- call `/internal/*`
- embed private API URLs/tokens

### `darkbox-telegram-miniapp`

Purpose: Telegram-native onboarding and demo surface.

Current status:

- Real package exists.
- Not currently wired into compose.
- Deployed experiment at `https://darkbox-mic.repo.box/`.
- Has mic probe and Blink deposit probe.
- Has server-side Blink signer scaffold.
- Current dev/test surfaces must be reviewed before public shipping.

Network:

- Should be `public_net`.
- Egress if it talks to Telegram/Blink.

Auth:

- Prefer Telegram init data.
- If desktop/web also ships, add wallet signature auth.

Must not:

- call hidden RPC
- call `/internal/*`
- expose internal market snapshot routes publicly

### `darkbox-ens`

Purpose: ENS subnames and commitment/reveal records.

Current status:

- Placeholder.
- Compose placeholder attached to `egress_net`.

Network:

- `egress_net`.
- Add `hidden_net` only if it needs internal commitment material directly.

Dependencies:

- ENS-compatible RPC/provider.
- Admin/operator key or controlled signing path.
- Commitment payloads from registration/reveal pipeline.

### `darkbox-reveal`

Purpose: final bundle and replay artifact builder.

Current status:

- Placeholder.
- Compose placeholder attached to `hidden_net` and `egress_net` with profile `reveal`.

Network:

- `hidden_net` for indexer/node/DB.
- `egress_net` only for publishing/upload.

Responsibilities:

- export chain blocks or trace
- export contract addresses/deploy metadata
- export orders/fills/positions/PnL
- export deposits/promo credits/withdrawals accounting
- export registration commitments and reveal preimages if allowed
- export agent action logs/model/runtime metadata
- produce replay data

### `darkbox-ethglobal-ingest`

Purpose: one-shot project snapshot fetcher.

Current status:

- Real Dockerfile.
- Compose profile `ingest`.

Network:

- `egress_net`.

Env:

- `ETHGLOBAL_EVENT_SLUG=newyork2026`

Command:

- `docker compose --profile ingest run --rm darkbox-ethglobal-ingest`

### `darkbox-ethglobal-watch`

Purpose: continuous 15-minute ETHGlobal fetch and resolution-check trigger.

Current status:

- Compose profile `ingest-watch`.
- Uses same Dockerfile as ingest.

Network:

- `egress_net`
- `hidden_net`

Env:

- `ETHGLOBAL_EVENT_SLUG=newyork2026`
- `ETHGLOBAL_REFRESH_SECONDS=900`
- `INDEXER_INTERNAL_URL=http://darkbox-indexer:8080/internal`

Behavior:

- fetch latest project snapshot
- POST `/internal/resolution/check?event=<slug>`
- sleep and repeat

## External dependency map

### Base

Used by:

- `darkbox-bridge`
- contract deploy scripts
- withdrawal flow
- possibly rebalancing later

Needs:

- Base mainnet RPC URL
- Base Sepolia RPC URL for test deployment
- USDC address
- deployer key with gas
- bridge contract address once deployed

### Arc

Used by:

- `darkbox-bridge`
- future public bridge deployment
- optional withdrawal destination/rebalancing

Needs Dan decision:

- exact Arc network and chain ID
- RPC URL
- USDC address
- bridge address/deployment plan

### Phala / CVM

Used by:

- `darkbox-transcriber`
- future `darkbox-signer`
- possibly indexer + DB
- maybe agent runtime

Needs:

- image build/push path
- CVM secrets injection plan
- attestation/log retrieval plan
- network egress allowlist

### Venice / model provider

Used by:

- `darkbox-agents` Venice strategy

Needs:

- `VENICE_API_KEY`
- model choice/rate limit budget
- fallback behavior if provider fails

### Telegram

Used by:

- `darkbox-telegram-miniapp`
- onboarding/auth
- optional voice note ingestion

Needs:

- bot token in private secret path
- Mini App URL/menu button config
- Telegram init data validation on server/API gateway

### ETHGlobal

Used by:

- ingest/watch services
- indexer context endpoints
- resolution dossiers for objective ETHGlobal metric markets

Needs:

- event slug (`newyork2026` currently in compose)
- fetch schedule
- snapshot retention/reveal policy

### Blink

Used by:

- Telegram Mini App deposit experiment

Current notes:

- Merchant ID: `95afb1dc-fcb0-471e-a1f7-3e1539af5f90`
- Algorithm: `ECDSA_P256_SHA256`
- Private key path loaded through `BLINK_MERCHANT_PRIVATE_KEY_PATH`

Do not put Blink private key in client code or public env.

### ENS

Used by:

- `darkbox-ens`
- commitments and reveal identity records

Needs:

- ENS/subname authority
- chain/provider
- writer key/permissions
- exact naming convention for agents

## Data flow summaries

### Deposit data flow

1. Public chain emits USDC transfer/deposit event.
2. `darkbox-bridge` sees event through Base/Arc RPC.
3. Bridge waits confirmations.
4. Bridge computes deposit operation ID.
5. Bridge resolves owner/shadow mapping.
6. Bridge calls `ShadowBridgeController.mintShadow(...)` on hidden chain.
7. Hidden chain emits `ShadowMinted`.
8. Indexer ingests and updates balance/funding state.
9. Public API shows safe deposit status.

### Agent turn data flow

1. `darkbox-agents` requests constrained observation from `/internal/agents/:agentId/state` and context endpoints.
2. Strategy emits candidate action JSON.
3. Validator checks shape and basic game/order constraints.
4. Runtime submits actions/txs to hidden chain once execution is wired.
5. Turn log records hashes and action metadata, not raw hidden prompt/observation.
6. Indexer ingests logs/events.
7. Public leaderboard/activity updates only safe aggregates.

### Resolution data flow

1. ETHGlobal watcher fetches snapshot every 15 minutes.
2. Watcher posts `/internal/resolution/check?event=newyork2026`.
3. Indexer evaluates open resolvable markets.
4. Indexer records a resolution dossier.
5. Hidden market settlement/contract state is updated when integration exists.
6. Reveal bundle includes dossier/snapshot hashes.

### Reveal data flow

1. Game ends.
2. `darkbox-reveal` reads indexer/node/DB/artifacts.
3. It exports accounting, chain, market, agent, and commitment data.
4. It writes replay data.
5. Frontend/Mini App switches from countdown to replay/reveal links.

## Things that are intentionally fake or demo-only today

- Agent trading can be random/noise/fixture-driven.
- Leaderboard can use seeded/indexer demo state until real chain ingestion is wired.
- Replay video can use fake-but-plausible events for pitch collateral if clearly separated from final audit truth.
- Telegram Mini App mic panel currently probes local microphone access; it does not complete real upload/transcription/commit.
- Blink deposit panel is a UX/payment probe, not final bridge attribution.

## Things that must become real before judging/demo claims

- Public/internal route leak test passing.
- Actual service containers for the components claimed as deployed.
- Hidden chain running with contracts deployed.
- Either real Frontier integration or a very clear demo shim.
- Transcriber or manual instruction flow that commits confirmed text.
- Key custody story for deployer/coordinator/signer.
- If showing withdrawals: isolated signer service or a frank “withdrawals disabled in MVP demo” statement.
