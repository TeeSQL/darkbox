# 02 — DarkBox Runbook for Dan's Agent

Date: 2026-06-13 UTC  
Repo: `/home/xiko/darkbox`  
Package manager: pnpm only.

This is the operational runbook. It is written so Dan can hand it directly to a coding agent.

## Ground rules before touching anything

1. Work from `/home/xiko/darkbox` unless Dan explicitly says otherwise.
2. Use `pnpm`, not npm.
3. Do not put real private keys, RPC secrets, Blink keys, Telegram tokens, Venice keys, or deployer keys in committed files.
4. Keep public and internal API boundaries strict.
5. Do not expose hidden RPC with a host `ports:` mapping.
6. Do not ship the Telegram Mini App dev/test internal snapshot behavior publicly.
7. Treat `.env.example` values as development-only samples.
8. Commit/push frequently if Dan has asked for autonomous implementation, but this handover-doc task itself did not push.

## Initial repository check

```bash
cd /home/xiko/darkbox
git status --short
find . -maxdepth 3 -name package.json -o -name Dockerfile -o -name README.md | sort
```

Expected notable paths:

- `docker-compose.yml`
- `docs/TECH_SPEC.md`
- `docs/DEPOSITS_WITHDRAWALS_SPEC.md`
- `docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md`
- `packages/contracts/`
- `services/indexer/`
- `services/agents/`
- `apps/telegram-miniapp/`
- `handover/dan/`

## Install dependencies

```bash
cd /home/xiko/darkbox
pnpm install
```

If Foundry dependencies are missing for contracts:

```bash
pnpm --filter @darkbox/contracts setup
```

## Build and typecheck

Run the broad checks first:

```bash
cd /home/xiko/darkbox
pnpm typecheck
pnpm build
```

Run targeted checks when iterating:

```bash
pnpm --filter @darkbox/shared typecheck
pnpm --filter @darkbox/indexer typecheck
pnpm --filter @darkbox/agents typecheck
pnpm --filter @darkbox/telegram-miniapp typecheck
```

## Contract build/test

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/contracts build
pnpm --filter @darkbox/contracts test
```

What exists today:

- `DarkBoxBridge.sol`
- `ShadowBridgeController.sol`
- tests for bridge/controller/EIP-712 parity
- `script/Deploy.s.sol` with `DeployPublic` and `DeployShadow`

What does not exist yet:

- finalized market factory/binary market contracts from `MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md`
- Frontier/orderbook integration deployment path
- audited PDFs
- production key custody

## Indexer local run

The indexer is currently the most runnable backend service.

Start it locally:

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/indexer dev
```

In another terminal, smoke-test public routes:

```bash
curl -s http://localhost:8080/public/health
curl -s http://localhost:8080/public/game
curl -s http://localhost:8080/public/markets
curl -s http://localhost:8080/public/leaderboard
curl -s http://localhost:8080/public/activity
curl -s http://localhost:8080/public/reveal/status
```

Smoke-test internal routes only from trusted/local context:

```bash
curl -s http://localhost:8080/internal/health
curl -s http://localhost:8080/internal/agents
curl -s http://localhost:8080/internal/leaderboard/raw
```

Run leak check:

```bash
pnpm --filter @darkbox/indexer check:public-leaks
```

If this fails, stop and fix before frontend/Mini App work. The public/internal visibility boundary is a core product invariant.

## ETHGlobal project ingestion

Fetch local snapshots:

```bash
cd /home/xiko/darkbox
pnpm fetch:ethglobal --event newyork2026
```

Optional with details for another event:

```bash
pnpm fetch:ethglobal --event cannes2026 --details
```

Expected output directory:

```text
data/ethglobal/<event>/projects.compact.json
data/ethglobal/<event>/projects.raw.json
data/ethglobal/<event>/manifest.json
```

Run one-shot Dockerized ingest:

```bash
docker compose --profile ingest run --rm darkbox-ethglobal-ingest
```

Run continuous watcher every 15 minutes:

```bash
docker compose --profile ingest-watch up -d darkbox-ethglobal-watch
```

Stop watcher:

```bash
docker compose stop darkbox-ethglobal-watch
```

Watcher behavior:

1. Fetch latest ETHGlobal submitted-project data.
2. Write snapshot under `data/ethglobal/<event>/`.
3. POST `http://darkbox-indexer:8080/internal/resolution/check?event=<event>`.
4. Sleep for `ETHGLOBAL_REFRESH_SECONDS`.

## Fake / in-house agent runs

The current agents package can generate plausible activity before real hidden-chain execution is complete.

### Random strategy demo

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/agents demo:random
```

Or with explicit CLI:

```bash
pnpm --filter @darkbox/agents exec tsx src/cli.ts random --kind random-maker --turns 3
```

### Venice strategy demo

Requires `VENICE_API_KEY` in the shell or repo `.env`.

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/agents demo:venice
```

If it fails because the key is missing, use random/noise strategy for demo liveness.

### Turn logs for replay/demo feed

Write hash-first turn logs:

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/agents exec tsx src/cli.ts random --turns 3 --log-dir .artifacts/agent-turns
```

Logs intentionally avoid dumping raw prompts/hidden observations by default. They include hashes, validation status, action counts/types, and submission refs when available.

### Noise runs

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/agents noise:random
pnpm --filter @darkbox/agents noise:venice
```

Use noise runs for fake in-house/demo agents when the market needs to feel alive. Keep them labeled as demo-generated unless/until they correspond to actual hidden-chain txs.

### Agent feed sync helper

There is a helper script:

```bash
scripts/agent-feed-sync.sh
```

It SSHes to `teebox`, reads agent logs from `/home/ubuntu/darkbox`, summarizes latest turns, and updates `agent-feed.json` on the `darkbox-mic` webroot. It depends on the remote log layout and repo.box access. Use carefully and inspect before running in a new environment.

## Generate fake agent keys

Script:

```bash
cd /home/xiko/darkbox
scripts/generate-agent-keys.sh 25
```

Outputs:

- public identities: `services/agents/config/agent-identities.json`
- private keys: `.secrets/agent-keys.private.json`

Requirements:

- `cast`
- `jq`

Important warnings:

- This is useful for local/demo fake agents.
- It is not a secure production key custody design.
- Fran explicitly called current private-key generation/storage insecure.
- Do not use these generated keys as final user/external custody keys.
- The private output is chmod 600 and gitignored, but that is not enough for production.

## Telegram Mini App run/build

Current package:

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/telegram-miniapp typecheck
pnpm --filter @darkbox/telegram-miniapp build
pnpm --filter @darkbox/telegram-miniapp dev
```

Current known facts:

- Primary bot: `@daemonhall_bot`.
- Legacy experiment bot: `@darkbox_mic_lab_bot`.
- Public URL: `https://darkbox-mic.repo.box/`.
- Build command outputs static assets under `apps/telegram-miniapp/dist/`.
- Blink signer scaffold reads `BLINK_MERCHANT_PRIVATE_KEY_PATH`.
- Bot token is ignored under `.secrets/telegram-bot-token`.

Critical warning:

The Mini App currently includes experimental/dev functionality and should be reviewed before shipping. Any route that fetches or returns `/internal/*` data must be removed or protected from public deployments.

## Docker Compose operations

Validate compose file:

```bash
cd /home/xiko/darkbox
docker compose config
```

Start the whole declared stack:

```bash
cd /home/xiko/darkbox
docker compose up --build
```

This may not produce a fully working product because several Dockerfiles/services are placeholders. Use this to find packaging gaps, not to claim deployment readiness.

Start the most useful local services:

```bash
cd /home/xiko/darkbox
docker compose up --build darkbox-db darkbox-node darkbox-indexer
```

Start ETHGlobal ingest one-shot:

```bash
docker compose --profile ingest run --rm darkbox-ethglobal-ingest
```

Start ETHGlobal watcher:

```bash
docker compose --profile ingest-watch up -d darkbox-ethglobal-watch
```

Start reveal profile when reveal service exists:

```bash
docker compose --profile reveal up --build darkbox-reveal
```

Stop stack:

```bash
docker compose down
```

Stop and remove volumes:

```bash
docker compose down -v
```

Hard local cleanup for stuck compose resources:

```bash
docker ps --filter name=darkbox
docker network ls | grep darkbox || true
docker volume ls | grep darkbox || true
```

## Docker networking rules

Current compose services and networks:

- `darkbox-node`: `hidden_net`, exposes `8545` internally only.
- `darkbox-db`: `hidden_net`.
- `darkbox-indexer`: `hidden_net`, `public_net`, exposes `8080` internally.
- `darkbox-agents`: `hidden_net`.
- `darkbox-bridge`: `hidden_net`, `egress_net`.
- `darkbox-ens`: `egress_net`.
- `darkbox-reveal`: `hidden_net`, `egress_net`, profile `reveal`.
- `darkbox-frontend`: `public_net`, host port `3000:3000`.
- `darkbox-ethglobal-ingest`: `egress_net`, profile `ingest`.
- `darkbox-ethglobal-watch`: `egress_net`, `hidden_net`, profile `ingest-watch`.

Missing from current compose:

- `darkbox-transcriber`
- `darkbox-telegram-miniapp`
- future `darkbox-signer`

Never add a host `ports:` mapping for the hidden node. `expose:` is fine for container-to-container access.

## CVM / Phala packaging plan

Use Docker Compose as the source-of-truth topology, then map confidential components into CVM.

Highest priority for CVM/TEE:

1. `darkbox-transcriber`
   - raw voice/audio and draft transcript privacy
   - provider credentials
   - transcript retention
2. `darkbox-signer`
   - withdrawal signer private key
   - public withdrawal authorization
3. `darkbox-indexer` + `darkbox-db`
   - hidden state, positions, fills, balances, logs

Medium priority:

- `darkbox-agents`
- `darkbox-bridge` coordinator side

Lower priority / public:

- `darkbox-frontend`
- `darkbox-telegram-miniapp`

For each CVM candidate, Dan's agent should document:

- image name/tag
- required env/secrets
- inbound routes
- outbound egress targets
- attached private storage
- logs/attestation retrieval method
- how to run locally with equivalent env

## Public bridge deployment runbook

Foundry deploy script lives at:

```text
packages/contracts/script/Deploy.s.sol
```

### Deploy public bridge to local/test chain

Environment variables for `DeployPublic`:

- `PRIVATE_KEY` — deployer key, pays gas.
- `ADMIN_ADDRESS` — multisig/admin role, defaults to deployer.
- `SIGNER_ADDRESS` — signer-service authorization key.
- `DEPLOY_MOCK_USDC=true` to deploy test mintable USDC.
- `USDC_ADDRESS` when not deploying mock USDC.

Example local/test style:

```bash
cd /home/xiko/darkbox/packages/contracts
PRIVATE_KEY=<deployer_private_key> \
ADMIN_ADDRESS=<admin_address> \
SIGNER_ADDRESS=<signer_address> \
DEPLOY_MOCK_USDC=true \
forge script script/Deploy.s.sol:DeployPublic --rpc-url <rpc_url> --broadcast
```

For Base Sepolia:

```bash
cd /home/xiko/darkbox/packages/contracts
PRIVATE_KEY=<deployer_private_key> \
ADMIN_ADDRESS=<admin_or_multisig> \
SIGNER_ADDRESS=<withdrawal_signer_address> \
USDC_ADDRESS=<base_sepolia_usdc_address> \
forge script script/Deploy.s.sol:DeployPublic --rpc-url <base_sepolia_rpc> --broadcast --verify
```

Do not run this with a placeholder key. Dan asked for a deployer private key stored in `.env` on teebox and Ocean's secrets with gas for Base/Arc bridges. That key setup is sensitive and was not done in this docs-only handover.

### Deploy shadow controller to hidden chain

Environment variables for `DeployShadow`:

- `PRIVATE_KEY` — hidden-chain deployer key.
- `COORDINATOR_ADDRESS` — bridge coordinator key, defaults to deployer.

Example:

```bash
cd /home/xiko/darkbox/packages/contracts
PRIVATE_KEY=<hidden_deployer_private_key> \
COORDINATOR_ADDRESS=<bridge_coordinator_address> \
forge script script/Deploy.s.sol:DeployShadow --rpc-url <hidden_rpc_url> --broadcast
```

Hidden RPC should be private-network only in real deployment.

## Bridge operations checklist

Before accepting real deposits:

- Confirm public bridge address.
- Confirm USDC address and decimals.
- Confirm source chain ID.
- Confirm confirmation threshold.
- Confirm deposit operation ID format.
- Confirm bridge service stores seen operations.
- Confirm shadow controller `mintProcessed` idempotency.
- Confirm owner -> shadow account mapping derivation.
- Confirm indexer sees `ShadowMinted`.
- Confirm public API reports deposit status without hidden leakage.

Before enabling withdrawals:

- Decide whether withdrawals are disabled during live game.
- Implement isolated signer service.
- Store signer key in CVM/TEE/secrets path.
- Verify user EIP-712 command schema.
- Verify shadow burn/lock before public signature.
- Bind authorization to destination chain/bridge/recipient/nonce/deadline.
- Test replay prevention.
- Test insufficient withdrawable balance.
- Test promo invite withdrawal lock.

## Transcriber implementation checklist

A runnable transcriber is missing. Dan's agent should create it before relying on voice instructions.

Required behavior:

- `POST /api/whispers/transcriptions`
- `GET /api/whispers/transcriptions/:whisperId`
- `POST /api/whispers/transcriptions/:whisperId/confirm`
- upload size/duration limits
- hash raw audio and transcript
- draft transcript only until user confirms
- confirmed transcript produces instruction hash/commitment payload
- provider keys private
- raw audio retention bounded
- no public listing of transcripts/audio

Security rules:

- spoken content is untrusted data
- no prompt injection from transcript into infrastructure policy
- no provider API key in frontend bundle
- no raw audio outside TEE unless explicitly accepted

## Frontend/Mini App API boundary

Use `handover/dan/frontend/README.md` as the frontend API package for Kristel/Nicolai.

Frontend should build against:

- public indexer routes
- authenticated self status
- invite claim
- whisper upload/status/confirm
- deposit intent/status
- registration
- withdrawable/withdrawal command/status

Frontend should not build against:

- `/internal/*`
- signer endpoints
- admin/reconciliation endpoints
- raw orderbook/fills/positions
- raw whisper audio/transcript retrieval
- hidden RPC

## Debugging playbook

### Public route leaks

Run:

```bash
pnpm --filter @darkbox/indexer check:public-leaks
```

Manually inspect public responses:

```bash
curl -s http://localhost:8080/public/leaderboard | jq .
curl -s http://localhost:8080/public/markets | jq .
curl -s http://localhost:8080/public/activity | jq .
```

Look for forbidden fields:

- `balance`
- `position`
- `orderbook`
- `fills`
- `prompt`
- `reasoning`
- `privateKey`
- `raw`
- `internal`

### Docker networking

Check effective compose:

```bash
docker compose config
```

Check containers:

```bash
docker compose ps
```

Inspect logs:

```bash
docker compose logs --tail=80 darkbox-indexer
docker compose logs --tail=80 darkbox-ethglobal-watch
```

From inside a container, test service name resolution:

```bash
docker compose exec darkbox-indexer sh -lc 'wget -qO- http://darkbox-node:8545 || true'
```

### ETHGlobal context

After fetching data and starting indexer, test:

```bash
curl -s 'http://localhost:8080/internal/context/ethglobal?event=newyork2026' | jq .
curl -s 'http://localhost:8080/internal/context/ethglobal/projects?event=newyork2026&q=wallet&limit=5' | jq .
```

### Agent logs

If using local `.artifacts`:

```bash
find .artifacts/agent-turns -type f -maxdepth 1 -name '*.ndjson' -print
 tail -20 .artifacts/agent-turns/*.ndjson
```

Keep log reads bounded. Do not dump huge logs into chat or agent context.

## Audit runbook

Fran asked for contract audits and PDFs. This was not completed in the docs-only handover.

Minimum next steps:

1. Run tests: `pnpm --filter @darkbox/contracts test`.
2. Run local Solidity audit workflow if available in Dan/Ocean environment.
3. Audit at least:
   - `DarkBoxBridge.sol`
   - `ShadowBridgeController.sol`
   - future market factory/binary market contracts
   - Frontier/orderbook integration wrappers
   - deploy scripts and role setup
4. Save reports under `handover/dan/audits/` or the repo audit directory Dan chooses.
5. Fix findings.
6. Rerun tests and audit.
7. Produce PDFs for Dan.

Focus areas:

- signature replay
- destination-chain binding
- nonce handling
- signer/admin rotation
- emergency withdrawal powers
- deposit idempotency
- shadow mint/burn replay
- locked/withdrawable accounting
- promo withdrawal lock
- USDC transfer quirks
- ownership mapping immutability
- Frontier integration trust assumptions

## Recommended next implementation sequence

If Dan's agent is building from here, use this order:

1. Make current tests/checks green and document baseline.
2. Make `docker compose config` clean.
3. Replace agents placeholder Dockerfile with real runtime image.
4. Add runnable `darkbox-transcriber` service and compose wiring.
5. Add Telegram Mini App compose service, but remove/protect dev-only internal snapshot behavior before public deploy.
6. Implement bridge service package around existing contracts/spec.
7. Implement isolated signer service before real withdrawals.
8. Replace hidden node placeholder with real hidden EVM image.
9. Deploy shadow controller to local hidden chain.
10. Deploy public bridge to Base Sepolia testnet.
11. Wire indexer to real chain events/Postgres.
12. Wire fake/random agents to submit real hidden actions or clearly label them as demo-only.
13. Implement reveal bundle writer.
14. Generate replay data/video collateral.
15. Run audit, fix, rerun.

## Stop/rollback safety

For local Docker:

```bash
cd /home/xiko/darkbox
docker compose down
```

For local Docker plus state reset:

```bash
docker compose down -v
```

For generated agent keys:

- Do not overwrite `.secrets/agent-keys.private.json` unless intentionally rotating all fake keys.
- Script refuses overwrite unless `FORCE=1`.

For deployments:

- Do not deploy with unknown keys.
- Do not publish public URLs until Caddy/routing/auth/security are verified.
- Do not enable withdrawals until signer isolation and replay tests pass.
