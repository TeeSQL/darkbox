# Docker + CVM Packaging Plan

Status: updated handover for Dan + Dan's agent  
Date: 2026-06-13 UTC  
Repo: `/home/xiko/darkbox`

## Goal

Make the DarkBox runtime runnable as a local Docker Compose stack first, then keep that topology portable to a Phala/CVM-style confidential deployment with minimal drift.

This document records:

- service/container boundaries
- hidden/public/egress network wiring
- what has real runtime packaging vs placeholder packaging
- local docker smoke commands and cleanup commands
- CVM/Phala mapping, especially transcriber and withdrawal signer boundaries
- concrete gaps Dan's agent should fix next

## Files Read For This Pass

- `handover/dan/00_FRAN_INSTRUCTIONS.md`
- `README.md`
- `docs/TECH_SPEC.md`
- `docker-compose.yml`
- service READMEs under `infra/node`, `apps/frontend`, `apps/telegram-miniapp`, and `services/*`
- package manifests at root, `apps/telegram-miniapp`, `services/indexer`, `services/agents`, `packages/shared`, and `packages/contracts`
- service Dockerfiles under `infra/node`, `infra/ethglobal-ingest`, `apps/frontend`, `apps/telegram-miniapp`, and `services/*`

## Current Packaging State

### Real build/runtime shape

- `darkbox-indexer`
  - Multi-stage Node/pnpm Dockerfile exists.
  - Builds `@darkbox/shared` and `@darkbox/indexer`.
  - Serves public and internal HTTP routes on `8080`.
  - Currently seeded/in-memory; Postgres is wired in compose but not yet used as the indexer source of truth.
- `darkbox-telegram-miniapp`
  - Multi-stage Node/pnpm Dockerfile exists.
  - Builds Vite static output and starts `src/server.ts` on `3014`.
  - Compose exposes host port `3014`.
  - Important: current server includes `/api/market-snapshot`, which intentionally reads internal indexer routes for a local/demo snapshot. Do not ship that endpoint in a real public deployment.
- `darkbox-ethglobal-ingest` / `darkbox-ethglobal-watch`
  - Dockerfile exists under `infra/ethglobal-ingest`.
  - One-shot ingest runs under profile `ingest`.
  - Watch loop runs under profile `ingest-watch`.

### Explicit placeholder packaging

These have Dockerfiles and compose services where applicable, but the images only run an Alpine sleep placeholder:

- `darkbox-node` at `infra/node`
- `darkbox-agents` at `services/agents`
- `darkbox-bridge` at `services/bridge`
- `darkbox-transcriber` at `services/transcriber`
- `darkbox-ens` at `services/ens`
- `darkbox-frontend` at `apps/frontend`
- `darkbox-reveal` at `services/reveal`

The placeholders are useful for compose/CVM topology validation, but they are not real product runtimes.

### Missing service/package gaps

- `darkbox-signer` does not exist yet. This is the serious withdrawal security gap called out in Fran's handoff.
- `services/transcriber` has README + placeholder Dockerfile, but no package/server implementation.
- `services/bridge`, `services/ens`, `services/reveal`, `apps/frontend`, and `infra/node` do not yet have real runtime packages.
- `services/agents` has a real TypeScript package, but its Dockerfile is still a placeholder because there is no long-running service entrypoint yet.

## Compose Network Topology

Compose networks are the source of truth for local service boundaries.

### `hidden_net`

Defined as Docker `internal: true`. It is not reachable directly from the host or outside compose.

Services attached:

- `darkbox-node`
- `darkbox-db`
- `darkbox-indexer`
- `darkbox-agents`
- `darkbox-bridge`
- `darkbox-transcriber`
- `darkbox-reveal`
- `darkbox-ethglobal-watch`

Allowed traffic:

- hidden RPC: `darkbox-node:8545`
- indexer internal API: `http://darkbox-indexer:8080/internal`
- indexer public API from public clients only through the indexer public surface: `http://darkbox-indexer:8080/public`
- Postgres: `darkbox-db:5432`

Rules:

- Public frontend and Telegram Mini App must never call `darkbox-node`.
- Public frontend and Telegram Mini App must never call `/internal/*`.
- Agents should use indexer internal APIs, not direct DB access.
- DB should eventually be reachable only by indexer/reveal/admin jobs where possible.

### `public_net`

Services attached:

- `darkbox-indexer`
- `darkbox-frontend`
- `darkbox-telegram-miniapp`

Allowed traffic:

- public UI traffic to frontend and Mini App
- public-safe indexer routes under `/public/*`

Current risk:

- `darkbox-indexer` is dual-homed on `hidden_net` and `public_net`. That is acceptable for the local MVP only while route filtering and leak tests remain strict. Long-term, split a public proxy from the hidden indexer process.

### `egress_net`

Services attached:

- `darkbox-agents`
- `darkbox-bridge`
- `darkbox-transcriber`
- `darkbox-ens`
- `darkbox-reveal`
- `darkbox-telegram-miniapp`
- `darkbox-ethglobal-ingest`
- `darkbox-ethglobal-watch`

Reasoning:

- `darkbox-agents`: Venice/model provider calls if agents call providers directly.
- `darkbox-bridge`: Base/Arc/public RPC and escrow observation.
- `darkbox-transcriber`: external STT provider only if local/in-CVM transcription is not used.
- `darkbox-ens`: ENS/chain provider writes.
- `darkbox-reveal`: optional artifact publishing.
- `darkbox-telegram-miniapp`: Telegram Bot API/webhook and public web egress.
- ETHGlobal services: event/project snapshot pulls.

Keep egress off services that do not need it, especially `darkbox-node`, `darkbox-db`, and `darkbox-indexer`.

## Service-by-Service Notes

### `darkbox-node`

- Current: placeholder image.
- Compose: `hidden_net`, volume `node_data`, `expose: 8545`, no host port.
- Need: real Reth/Geth/devnet image, chain config, contract deployment path.
- CVM: belongs inside hidden confidential plane. Do not expose RPC publicly.

### `darkbox-db`

- Current: `postgres:16-alpine`.
- Compose: `hidden_net`, volume `db_data`.
- Need: migrations and indexer persistence integration.
- CVM: should live inside the same confidential boundary as indexer in production.

### `darkbox-indexer`

- Current: real Node service.
- Compose: `hidden_net` + `public_net`.
- Env: `HIDDEN_RPC_URL`, `DATABASE_URL`, `DATA_DIR`, `ETHGLOBAL_EVENT_SLUG`.
- Need: Postgres persistence, migrations, healthcheck, stronger public/internal separation.
- CVM: medium/high priority because it materializes hidden state, fills, positions, balances, and agent logs.

### `darkbox-agents`

- Current: real TS CLI/package, placeholder container.
- Compose: `hidden_net` + `egress_net`.
- Env: `INDEXER_INTERNAL_URL`, `HIDDEN_RPC_URL`.
- Need: real long-running runner entrypoint or one-shot job pattern, provider secret injection, chain tx submission.
- CVM: private plane. Per-agent isolation or CVM can come later; for MVP, hidden network plus constrained egress is the first boundary.

### `darkbox-bridge`

- Current: placeholder container.
- Compose: `hidden_net` + `egress_net`.
- Env: `INDEXER_INTERNAL_URL`, `HIDDEN_RPC_URL`.
- Need: real bridge package, deposit watcher, idempotent shadow mint/burn coordination, withdrawal command validation.
- Security: do not colocate final withdrawal signing key here if a signer service can be isolated.

### `darkbox-signer`

- Current: not implemented.
- Required next service for real withdrawals.
- Should be a separate service from `darkbox-bridge`.
- Should expose only narrow approval/sign endpoints to bridge.
- Should keep signing key in Phala/CVM, TEE secret store, or equivalent enclave path.
- Must never expose key material to frontend, Mini App, indexer, agents, or logs.

### `darkbox-transcriber`

- Current: README + placeholder Dockerfile + compose service.
- Compose: `hidden_net` + `egress_net`.
- Env: `INDEXER_INTERNAL_URL`.
- Need: real upload/status/confirm API and private temp/retention storage.
- Phala/CVM priority: highest. It handles raw voice/audio, draft transcripts, provider credentials, and private strategy text before user confirmation.
- Public access should only happen through a narrow public proxy for upload/status/confirm. Raw audio and drafts must remain inside the private/CVM boundary.
- Spoken/transcribed text is user data, not privileged system instructions.

### `darkbox-ens`

- Current: placeholder container.
- Compose: `egress_net`.
- Need: worker/service for ENS subnames and commitment/reveal records.
- If it consumes private commitment material directly, move it onto `hidden_net` too and keep API coupling narrow.

### `darkbox-frontend`

- Current: placeholder container.
- Compose: `public_net`, host port `3000`.
- Env: `PUBLIC_INDEXER_URL=http://darkbox-indexer:8080/public`.
- Need: real public web app runtime.
- Must not embed hidden/internal URLs or secrets.

### `darkbox-telegram-miniapp`

- Current: real package and Dockerfile.
- Compose: `public_net` + `egress_net`, host port `3014`.
- Env: `INDEXER_PUBLIC_URL=http://darkbox-indexer:8080`, `MINIAPP_URL=http://darkbox-telegram-miniapp:3014`.
- Need before production: remove or gate `/api/market-snapshot` because it fetches internal routes and returns demo-only aggregate/internal data.
- Public boundary: same as frontend, plus narrow whisper/deposit proxy routes when implemented.

### `darkbox-reveal`

- Current: placeholder container.
- Compose: profile `reveal`, `hidden_net` + `egress_net`.
- Need: real reveal artifact builder, writable artifact volume, chain/indexer export logic.
- CVM: can run inside hidden plane during reveal. Egress only if publishing bundles externally.

## Local Docker Smoke

### Config validation

```bash
cd /home/xiko/darkbox
docker compose config
```

Result from this pass: succeeded.

### Build validation

```bash
cd /home/xiko/darkbox
docker compose build
docker compose build darkbox-reveal
docker compose --profile ingest build darkbox-ethglobal-ingest
docker compose --profile ingest-watch build darkbox-ethglobal-watch
```

Result from this pass: all succeeded.

Note: Docker emitted `Docker Compose is configured to build using Bake, but buildx isn't installed`. This is a host tooling warning, not a build failure.

### Hidden indexer smoke

Start a minimal stack:

```bash
cd /home/xiko/darkbox
docker compose up -d --build darkbox-db darkbox-node darkbox-indexer darkbox-transcriber
```

Check public and internal indexer health from inside the compose network:

```bash
docker compose exec -T darkbox-indexer node -e "fetch('http://127.0.0.1:8080/public/health').then(r=>r.text()).then(t=>console.log(t))"
docker compose exec -T darkbox-indexer node -e "fetch('http://darkbox-indexer:8080/internal/health').then(r=>r.text()).then(t=>console.log(t))"
```

Observed output from this pass:

```json
{ "ok": true, "surface": "public" }
{ "ok": true, "surface": "internal" }
```

### Telegram Mini App smoke

Normal command:

```bash
cd /home/xiko/darkbox
docker compose up -d --build darkbox-db darkbox-node darkbox-indexer darkbox-telegram-miniapp
curl -fsS http://127.0.0.1:3014/healthz
curl -fsS http://127.0.0.1:3014/public/health
```

Observed blocker from this pass:

- host port `3014` was already in use by a local `node` process
- compose could not start `darkbox-telegram-miniapp` with `ports: "3014:3014"`

If Dan's agent hits the same conflict, either stop the unrelated host process deliberately or use a temporary override:

```bash
cd /home/xiko/darkbox
docker compose up -d --build darkbox-db darkbox-node darkbox-indexer
docker compose run --rm -p 3015:3015 -e PORT=3015 darkbox-telegram-miniapp
```

For a clean committed fix, change the host port only through an override file, not by silently changing the canonical compose port.

### Optional ETHGlobal ingest

One-shot:

```bash
cd /home/xiko/darkbox
docker compose --profile ingest run --rm darkbox-ethglobal-ingest
```

Watch loop:

```bash
cd /home/xiko/darkbox
docker compose --profile ingest-watch up -d darkbox-ethglobal-watch
```

Observed cleanup note:

- A prior `darkbox-ethglobal-ingest-run-*` container was already running for about 5 hours and kept `darkbox_egress_net` in use.
- I did not kill it because it may belong to another workstream.

## Kill / Cleanup Commands

Stop compose services without removing data:

```bash
cd /home/xiko/darkbox
docker compose down
```

Stop and remove local DB/node volumes:

```bash
cd /home/xiko/darkbox
docker compose down -v
```

Stop and remove local images built by this compose project:

```bash
cd /home/xiko/darkbox
docker compose down --rmi local -v
```

Inspect leftovers before killing anything that may belong to another agent:

```bash
docker compose ps -a
docker ps --filter name=darkbox
docker network inspect darkbox_egress_net --format '{{json .Containers}}'
docker volume ls | grep darkbox
```

If a stale one-shot ingest container is confirmed safe to remove:

```bash
docker rm -f <container-id-or-name>
docker network rm darkbox_egress_net
```

Do not remove unrelated containers or host processes without checking ownership.

## Phala / CVM Mapping

### Recommended confidential deployment units

1. Core hidden CVM
   - `darkbox-node`
   - `darkbox-indexer`
   - `darkbox-db`
   - optional `darkbox-reveal`
   - internal-only RPC/API surface

2. Transcriber CVM
   - `darkbox-transcriber`
   - private audio temp storage and transcript draft storage
   - STT provider credentials or local model weights
   - narrow public proxy ingress only for upload/status/confirm

3. Signer CVM
   - future `darkbox-signer`
   - withdrawal authorization key
   - approval/sign API reachable only by `darkbox-bridge`

4. Public edge
   - `darkbox-frontend`
   - `darkbox-telegram-miniapp`
   - public route/proxy layer for `/public/*`, whisper upload/status/confirm, and public bridge deposit/status endpoints

### Transcriber security boundary

Keep inside the transcriber CVM:

- raw audio
- Telegram voice-file fetch handling, if used
- draft transcript
- transcript metadata before confirmation
- provider keys
- retention storage

Allowed out:

- `whisperId`
- language/duration/quality metadata
- user-confirmed final transcript hash or instruction commitment payload

Do not let provider output become committed instructions without explicit user confirmation or edit.

### Signer security boundary

Keep inside signer CVM:

- withdrawal signer private key
- signing policy configuration
- nonce/state needed to prevent replay

Allowed in:

- bridge request with shadow burn proof/confirmation
- validated withdrawal command digest

Allowed out:

- signature or rejection
- audit-safe signing metadata, never the key

This signer is not implemented yet. Dan should prioritize it before any serious withdrawal demo.

## Immediate Risks

- `darkbox-signer` is missing and withdrawal key custody is still insecure by design.
- `darkbox-transcriber` has only placeholder packaging; no API exists yet.
- Telegram Mini App includes demo-only internal snapshot behavior and must not be deployed publicly as-is.
- `darkbox-node`, `darkbox-bridge`, `darkbox-ens`, `darkbox-frontend`, and `darkbox-reveal` are placeholder containers.
- `darkbox-agents` has real code but no long-running Docker entrypoint.
- Indexer public/internal route separation exists in one dual-homed process; keep leak tests strict and split a public proxy if time allows.
- Postgres is in compose, but the current indexer server is seeded/in-memory.

## Recommended Next Sequence For Dan's Agent

1. Implement `darkbox-signer` as a separate service and decide its CVM/secret path.
2. Implement `darkbox-transcriber` API behind the existing placeholder Docker/compose shape.
3. Remove or production-gate Telegram `/api/market-snapshot`.
4. Replace `darkbox-agents` placeholder Dockerfile with a real runner once the long-running entrypoint is defined.
5. Replace `darkbox-node` placeholder with real hidden Reth/Geth/devnet image.
6. Implement bridge runtime package and keep signer key outside bridge.
7. Add DB migrations and connect indexer to Postgres.
8. Add healthchecks for real services.
9. Add an override compose file for local port conflicts instead of editing canonical ports.
10. Convert the validated compose topology into Phala/CVM manifests, preserving the same hidden/public/egress boundaries.

## Changes Made In This Workstream

- Added `egress_net` to `darkbox-agents` in `docker-compose.yml` because the agent README documents direct Venice/model provider usage.
- Verified compose config.
- Verified default/profied Docker builds.
- Ran a local hidden-stack smoke and confirmed indexer public/internal health routes.
- Cleaned up the smoke containers and volumes with `docker compose down -v`.
- Preserved active Telegram UI and agent runtime code.
