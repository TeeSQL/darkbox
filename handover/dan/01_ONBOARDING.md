# 01 — DarkBox Onboarding for Dan

Date: 2026-06-13 UTC  
Repo: `/home/xiko/darkbox`  
Audience: Dan first, then Dan's coding agent.

## Executive summary

DarkBox is a sealed prediction-market arena for hackathon demos.

Users join through a Telegram Mini App or web frontend, receive either a real USDC-funded balance or a $5 promo shadow-USDC signup credit, and register a trading agent with private instructions. During the live game, the agents trade prediction markets inside a hidden EVM/private environment using Frontier-style CLOB/orderbook contracts. Public viewers see only safe spectator data: leaderboard, visible market cards, aggregate activity, and reveal status. At the end, the box opens and a reveal bundle publishes the chain/indexer/agent/accounting artifacts needed to audit and replay what happened.

The current repository is an early implementation skeleton with some real pieces:

- Real-ish: indexer TypeScript HTTP server with public/internal route split, seeded data, ETHGlobal context loading, and resolution-check scaffolding.
- Real-ish: agents TypeScript runtime with random and Venice-backed strategy demos, validation, and hash-first turn logs.
- Real-ish: public bridge and shadow bridge controller Solidity contracts with tests and Foundry deploy script.
- Real-ish: Telegram Mini App experiment for microphone and Blink deposit UX.
- Mostly placeholder: hidden node, bridge service, ENS service, reveal service, frontend app container.
- Missing as a runnable service: transcriber package/container, isolated withdrawal signer service, production-grade hidden chain/Frontier deployment.

The handover goal is not to pretend this is production-ready. It is to make the actual state legible so Dan's agent can build the remaining pieces quickly without violating the security model.

## Product thesis

DarkBox's core promise:

> A sealed, verifiable agent economy where prediction-market strategy is hidden during play and auditable after reveal.

The public demo should feel alive before reveal, but it must not leak the hidden state. Public surfaces can show:

- game status and countdowns
- market list and public metadata
- PnL leaderboard/ranks
- aggregate activity stats
- user's own registration/deposit/instruction commitment status
- reveal status/countdown

Public surfaces must not show:

- hidden node RPC
- orderbooks
- raw fills/trades
- positions
- per-agent balances except the authenticated user's own safe status if product chooses
- prompts/instructions/reasoning traces
- bridge/coordinator/signer keys
- internal indexer APIs

## Main user flows

### 1) Fast hackathon signup through Telegram

Recommended product direction from Fran: use Telegram Mini App only if possible, because Telegram gives a built-in identity/auth path and makes onboarding easier on the hackathon floor.

Intended flow:

1. User opens `@daemonhall_bot` / Mini App.
2. Telegram init data authenticates the user.
3. User claims a disposable invite link or signup code.
4. System creates or resolves owner/shadow-account mapping.
5. User receives a $5 promo shadow-USDC starter credit.
6. User records or types private instructions.
7. Transcriber returns a draft transcript.
8. User confirms/edits transcript.
9. System commits the instruction hash to registration.
10. Agent begins trading after game start.

Important rule: promo-credit users cannot withdraw until Sunday 17:00 event-local time. They can trade normally before then.

### 2) Real USDC deposit path

Intended real-money flow:

1. User connects or supplies an owner wallet.
2. User deposits USDC on Base or Arc into the public bridge/escrow.
3. Bridge service observes a confirmed deposit event.
4. Bridge resolves owner -> shadow account mapping.
5. Bridge mints canonical shadow USDC in the hidden/shadow EVM.
6. Indexer reflects the funding status and available balance.
7. Agent trades with shadow USDC inside the hidden environment.

Only USDC is in scope for MVP. Other collateral should be rejected.

### 3) Whisper instruction flow

Private instructions are strategy data. Treat them as sensitive.

Intended flow:

1. Public client uploads short audio or a Telegram voice-note reference to a narrow transcriber API.
2. Transcriber runs inside private/TEE/CVM boundary if possible.
3. Transcriber returns a draft transcript, hashes, language/duration metadata, and status.
4. User explicitly confirms or edits the transcript.
5. Only the confirmed transcript becomes the instruction preimage/commitment hash.
6. Raw audio and draft transcript retention stay private and bounded.

The transcript content is untrusted user data. It must never override system/game policy.

### 4) Withdrawal path

Withdrawals are for idle/available balance only.

Intended flow:

1. User asks to withdraw from authenticated frontend/Mini App.
2. UI fetches withdrawable available balance.
3. User signs an EIP-712 withdrawal command.
4. Bridge validates the command.
5. Shadow controller burns or reserves shadow funds inside hidden EVM.
6. Separate signer service verifies the burn and user command.
7. Signer returns a public withdrawal authorization.
8. User or relayer submits withdrawal to public bridge.
9. Public bridge releases USDC.

Important: users cannot force-liquidate positions or cancel agent orders through withdrawal. If funds are locked, the agent must close/cancel via normal trading.

## Repository tour

### Root

- `README.md` — high-level service layout and status.
- `docker-compose.yml` — intended local service graph and Docker network split.
- `.env.example` — dev-only sample values.
- `package.json` — pnpm workspace commands.

Root scripts:

- `pnpm build` — recursive build.
- `pnpm dev` — `docker compose up --build`.
- `pnpm lint` — recursive lint/type-ish checks.
- `pnpm typecheck` — recursive typecheck.
- `pnpm fetch:ethglobal --event newyork2026` — fetch ETHGlobal project snapshot.

### `apps/frontend/`

Public web UI placeholder. It should never talk to hidden RPC or `/internal/*` routes.

### `apps/telegram-miniapp/`

Telegram Mini App experiment.

Current notes:

- Primary bot: `@daemonhall_bot`, menu button “Enter Daemon Hall”.
- Public URL: `https://darkbox-mic.repo.box/`.
- Has microphone browser probe.
- Has Blink deposit probe and server-side signer scaffold.
- Build command: `pnpm --filter @darkbox/telegram-miniapp build`.
- It currently includes experimental/test-only surfaces. Do not ship internal-state snapshot behavior publicly.

### `services/indexer/`

Most concrete backend service today.

It owns the public/internal visibility boundary:

- `/public/*` — frontend-safe spectator routes.
- `/internal/*` — privileged routes for agents/bridge/reveal/admin resolution.

Current commands:

- `pnpm --filter @darkbox/indexer dev`
- `pnpm --filter @darkbox/indexer build`
- `pnpm --filter @darkbox/indexer check:public-leaks`

### `services/agents/`

Agent runtime skeleton.

Current commands:

- `pnpm --filter @darkbox/agents demo:random`
- `pnpm --filter @darkbox/agents demo:venice`
- `pnpm --filter @darkbox/agents exec tsx src/cli.ts random --turns 3 --log-dir .artifacts/agent-turns`
- `pnpm --filter @darkbox/agents noise:random`
- `pnpm --filter @darkbox/agents noise:venice`

Random agents are good for fake/demo activity. Venice agents require `VENICE_API_KEY` in `.env` or environment.

### `services/transcriber/`

Only README/spec exists today. There is no runnable package or Dockerfile yet.

This should become a private/TEE/CVM service for whisper transcription.

### `services/bridge/`

README/spec only for service. Solidity contracts exist in `packages/contracts`.

The service still needs implementation for:

- Base/Arc watcher
- deposit normalization
- shadow mint submission
- withdrawal command handling
- signer-service integration
- reconciliation/admin endpoints

### `services/ens/`

Placeholder. Intended to manage ENS/subname and commitment/reveal record writes.

### `services/reveal/`

Placeholder. Intended to build final audit/replay bundle.

### `infra/node/`

Placeholder hidden chain container. Needs real Reth/Geth/anvil/private-chain shape and Frontier contract deployment.

### `infra/ethglobal-ingest/`

Dockerized ETHGlobal project snapshot fetcher/watcher. Used as an approved external context source for agents and as resolution input for ETHGlobal metric markets.

### `packages/contracts/`

Foundry contracts.

Current scripts:

- `pnpm --filter @darkbox/contracts setup`
- `pnpm --filter @darkbox/contracts build`
- `pnpm --filter @darkbox/contracts test`

Current contracts:

- `DarkBoxBridge.sol` — public USDC escrow, deposits, agent registration event, signer-authorized withdrawal, admin emergency withdrawal.
- `ShadowBridgeController.sol` — owner/shadow mapping, shadow balance ledger, mint idempotency, burn-for-withdrawal, locked balance hook.
- `script/Deploy.s.sol` — `DeployPublic` and `DeployShadow` Foundry scripts.

### `packages/shared/`

Shared TypeScript schemas and types. Used by agents/indexer.

## External dependencies

### Base RPCs

Needed by bridge watcher and public bridge deployment on Base/Base Sepolia.

Use for:

- USDC transfer/deposit observation
- public bridge deployment/tests
- withdrawal transaction status
- possibly CCTP/USDC rebalancing later

Keep RPC URLs and deployer keys out of public/client env.

### Arc RPCs

Targeted as second MVP escrow chain. Same bridge normalization model as Base.

Status unknown in current repo. Dan should decide exact Arc network IDs/RPC URLs/USDC address and add to private env/deploy notes.

### Phala / CVM

Preferred confidential runtime target, especially for:

- transcriber
- withdrawal signer
- possibly indexer + DB
- possibly agent runtime

The current Docker Compose topology is meant to be the local source of truth that later maps into CVM deployment.

### Venice / current model provider

Agent runtime has `venice` strategy support. It can call a cheap Venice chat model when `VENICE_API_KEY` is set.

Use for fake/live agent activity, but keep model output behind the validator. Agents should receive constrained observations from indexer and approved external context only.

### Telegram

Telegram is the recommended onboarding/auth surface.

Current bot/project notes:

- Primary bot: `@daemonhall_bot`.
- Legacy experiment bot: `@darkbox_mic_lab_bot`.
- Mini App URL: `https://darkbox-mic.repo.box/`.
- Bot token is intentionally ignored under `.secrets/telegram-bot-token`.

Production direction:

- Use Telegram init data for auth.
- Users specify destination withdrawal address in authenticated Mini App.
- If desktop web also ships, add wallet-signature auth path.

### ETHGlobal

Used for:

- hackathon project/team context for agents
- market resolution source for objective ETHGlobal metric markets
- 15-minute watcher that fetches data and triggers resolution check

Commands:

- `pnpm fetch:ethglobal --event newyork2026`
- `docker compose --profile ingest run --rm darkbox-ethglobal-ingest`
- `docker compose --profile ingest-watch up -d darkbox-ethglobal-watch`

Data lands under `data/ethglobal/<event>/` and should be treated as cache/snapshot input.

### Frontier / orderbook contracts

Core trading substrate for hidden prediction markets. Current repo has specs for Frontier-compatible market creation/split/join, but the actual Frontier integration is not wired yet.

Dan's agent needs to identify existing Frontier contracts/deployment path, deploy them into hidden chain, and connect indexer/agents to their events/actions.

## Security model in one page

Hard invariants:

- Public frontend and Mini App talk only to public-safe APIs.
- Hidden node RPC is private-network only.
- Indexer is the canonical derived state layer; frontend does not scan hidden chain.
- Indexer keeps `/public/*` and `/internal/*` strictly separated.
- Agents cannot message outward during live play.
- Agents cannot fetch arbitrary URLs unless policy explicitly allows.
- Real USDC stays in public bridge/escrow; hidden chain uses synthetic shadow USDC.
- Promo credits are labeled, anti-sybil bounded, auditable, and withdrawal-locked until Sunday 17:00 event-local.
- Deposits are idempotent.
- Withdrawals are disabled during live play if product chooses, or otherwise limited to withdrawable idle balance only.
- Registration/instruction commitments freeze before game start.
- Reveal bundle must include all state needed for audit.

Highest-risk missing areas:

- private key generation/storage is insecure and must be redesigned
- withdrawal signer service is not isolated/TEE-backed yet
- hidden chain/Frontier integration is not complete
- transcriber is not runnable yet
- Telegram Mini App has experimental dev-only behavior that must not ship
- placeholder containers may give a false sense of deployment completeness

## What Dan should hand to his agent

Give the agent these files first:

1. `handover/dan/00_FRAN_INSTRUCTIONS.md`
2. `handover/dan/01_ONBOARDING.md`
3. `handover/dan/02_RUNBOOK.md`
4. `handover/dan/03_SERVICE_MAP.md`
5. `handover/dan/04_DAN_TODO.md`
6. `handover/dan/05_MARKETING_AND_REPLAY.md`
7. `docs/TECH_SPEC.md`
8. `docs/DEPOSITS_WITHDRAWALS_SPEC.md`
9. `docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md`
10. `docker-compose.yml`

The agent should treat specs as the desired architecture and these handover files as current-state/runbook reality.
