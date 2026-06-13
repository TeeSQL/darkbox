# 04 — Dan TODO / Missing and Unsafe Pieces

Date: 2026-06-13 UTC  
Repo: `/home/xiko/darkbox`

This is the blunt list. It separates what exists from what Dan or Dan's agent still needs to fix, implement, or decide.

## P0 — Must resolve before a credible judged demo

### 1) Key custody is currently insecure / incomplete

Fran explicitly called this out.

Current reality:

- `scripts/generate-agent-keys.sh` can generate fake/demo agent wallets into `.secrets/agent-keys.private.json`.
- Foundry deploy scripts expect `PRIVATE_KEY` in env.
- Bridge contract has a `signer` role, but the isolated signing service is not implemented.
- There is no finalized policy for deployer/admin/coordinator/signer key storage.

Required decisions/actions:

- Create a deployer private key for testnet deployments only if Dan explicitly approves the custody path.
- Store deployer key in `.env` on teebox and Ocean's secrets as requested by Fran, but do not commit it.
- Fund deployer with gas for Base/Base Sepolia/Arc as needed.
- Create separate keys/roles for:
  - deployer
  - public bridge admin/multisig
  - public bridge withdrawal signer
  - hidden bridge coordinator
  - fake demo agents
  - real user custody if any
- Do not reuse deployer as withdrawal signer in final demo if avoidable.
- Move withdrawal signer key into TEE/CVM/dedicated secret service.

Acceptance criteria:

- A human-readable key/role inventory exists.
- No real keys are in git.
- Public bridge signer key is not inside frontend/Mini App/bridge logs.
- Withdrawal authorization can be rotated or paused.

### 2) Withdrawal signer service is missing and must move into TEE/security land

Current reality:

- `DarkBoxBridge` verifies a service signature.
- `ShadowBridgeController` supports burn-for-withdrawal.
- The service that verifies shadow burn and signs public withdrawal authorization does not exist.

Required actions:

- Implement `darkbox-signer` as a separate service.
- Put it on hidden/confidential network only.
- Store signer key in CVM/TEE/secrets path.
- Expose a narrow signing endpoint only to `darkbox-bridge`.
- Verify:
  - user EIP-712 withdrawal command
  - owner -> shadow mapping
  - shadow burn/lock event
  - nonce not used
  - deadline
  - destination chain/bridge/recipient/amount binding
- Emit/sign audit logs without leaking private key material.

Acceptance criteria:

- No public route can access signer.
- Replay tests pass.
- Wrong destination chain/bridge fails.
- Duplicate nonce fails.
- Shadow burn missing => no signature.

### 3) Hidden chain / Frontier integration is not done

Current reality:

- `infra/node` is placeholder.
- Market factory/split/join spec exists, but contracts are not implemented in repo.
- Frontier/orderbook integration is specified but not wired.
- Agents do not yet submit real hidden-chain trades.
- Indexer does not yet ingest real Frontier/DarkBox contract events.

Required actions:

- Choose hidden chain runtime: Reth, Geth, Anvil, or equivalent.
- Containerize it without public RPC exposure.
- Deploy Frontier/orderbook contracts inside hidden chain.
- Implement/deploy DarkBox market factory and binary market/split-join contracts.
- Wire indexer event ingestion.
- Wire agents to submit validated transactions.
- Add reveal export of deployment metadata and chain events.

Acceptance criteria:

- Hidden RPC only reachable on `hidden_net`.
- Contract deployment addresses recorded.
- At least one market can be created, split, traded or simulated, resolved, and exported.
- Indexer reflects derived state from events, not only seeds.

### 4) Transcriber service is not runnable

Current reality:

- `services/transcriber/README.md` specifies the API.
- No package/container was observed.
- Telegram Mini App mic probe does not upload/transcribe/commit real instructions.

Required actions:

- Implement service with endpoints:
  - `POST /api/whispers/transcriptions`
  - `GET /api/whispers/transcriptions/:whisperId`
  - `POST /api/whispers/transcriptions/:whisperId/confirm`
- Add Dockerfile and compose service.
- Keep raw audio and draft transcripts private.
- Add provider/local STT integration.
- Hash audio/transcript.
- Require user confirmation/edit before instruction commit.
- Add upload limits and retention policy.

Acceptance criteria:

- User can record/upload a short whisper.
- User sees draft transcript.
- User can edit/confirm transcript.
- Confirmed transcript returns instruction hash/commitment payload.
- No raw transcript/audio leaks through public leaderboard APIs.

### 5) Telegram Mini App auth path needs finalization

Current reality:

- Telegram Mini App experiment exists.
- Primary bot: `@daemonhall_bot`.
- Public URL: `https://darkbox-mic.repo.box/`.
- It probes mic and Blink deposit UX.
- It is not wired into Docker Compose.
- Dev/test internal snapshot behavior must not ship.

Required actions:

- Validate Telegram init data server-side.
- Decide if Telegram-only auth is the MVP.
- If yes, bind user to Telegram id/handle and wallet/destination withdrawal address inside Mini App.
- Remove/protect any route that returns internal indexer data.
- Add compose service and deployment notes.
- Make invite claim, instruction confirm, and self-status flow work.

Acceptance criteria:

- Public Mini App cannot access `/internal/*`.
- Telegram auth validated server-side.
- User can claim invite and see self-status.
- User can submit/confirm instructions.

### 6) Public/internal API boundary must stay strict

Current reality:

- Indexer has public/internal routes and a leak-check script.
- It is dual-homed to `hidden_net` and `public_net`.

Required actions:

- Run `pnpm --filter @darkbox/indexer check:public-leaks` after every indexer/public API change.
- Add tests for all new public endpoints.
- Prefer a separate public proxy if route risk grows.

Acceptance criteria:

- Public routes never show orderbooks, raw fills, positions, balances, prompts, raw logs, or hidden RPC data.

## P0 — Contract/deploy/audit requirements from Fran

### 7) Base Sepolia test deployment is not done in this handover

Required actions:

- Prepare deployer key with gas.
- Decide `ADMIN_ADDRESS` and `SIGNER_ADDRESS`.
- Decide Base Sepolia USDC address or deploy mock USDC for tests.
- Run Foundry script:

```bash
cd /home/xiko/darkbox/packages/contracts
PRIVATE_KEY=<deployer_private_key> \
ADMIN_ADDRESS=<admin_or_multisig> \
SIGNER_ADDRESS=<withdrawal_signer_address> \
USDC_ADDRESS=<base_sepolia_usdc_address> \
forge script script/Deploy.s.sol:DeployPublic --rpc-url <base_sepolia_rpc> --broadcast --verify
```

- Record addresses in a deployment note under handover/deploy docs or repo deployment docs.

Acceptance criteria:

- Base Sepolia bridge address recorded.
- Admin/signer/USDC/deployer addresses recorded.
- Tx hash recorded.
- Verification status recorded.

### 8) Deploy scripts for all onchain/private-network contracts are incomplete

Current reality:

- Deploy script exists for public bridge and shadow controller.
- Market factory/split-join and Frontier deployment scripts are missing/not wired.

Required actions:

- Add deploy scripts for:
  - public bridge on Base
  - public bridge on Arc
  - shadow bridge controller on hidden chain
  - synthetic USDC / shadow ledger if separate
  - market factory
  - binary market implementation if using clones/factory
  - Frontier/orderbook contracts or wrapper/adapters
  - ENS/subname/commitment writer if contract-based

Acceptance criteria:

- Fresh environment can deploy all contracts from documented commands.
- Deployed addresses are captured in machine-readable and human-readable output.

### 9) Audit routine and PDFs are not done

Required actions:

- Run tests.
- Run Solidity audit workflow.
- Audit bridge, shadow controller, market factory/split-join, and Frontier/orderbook integration.
- Fix findings.
- Rerun.
- Save PDFs in repo/handover audit folder.

Acceptance criteria:

- Reports exist.
- Findings triaged by severity.
- Fix commits documented.
- Rerun report confirms resolution or accepted risk.

## P1 — Needed for strong demo/product completeness

### 10) Bridge service implementation missing

Current reality:

- Service README exists.
- Compose placeholder exists.
- No real watcher/coordinator service observed.

Required actions:

- Implement Base/Arc watchers.
- Normalize deposit operation IDs.
- Store deposit states.
- Resolve owner/shadow mapping.
- Submit `mintShadow`.
- Expose public-safe deposit status and withdrawable status APIs.
- Expose internal/admin reconciliation endpoints only privately.

Acceptance criteria:

- Same deposit observed twice does not mint twice.
- Failed/crashed mint can reconcile from hidden-chain event.
- Public deposit status does not leak hidden positions/orderbooks.

### 11) Invite / $5 signup bonus flow missing

Required actions:

- Implement invite creation/claim records.
- Bind claim to Telegram identity and/or wallet.
- Enforce one bonus per identity/wallet per game unless admin override.
- Mint promo shadow USDC with separate operation ID.
- Enforce Sunday 17:00 event-local withdrawal lock.
- Include promo credits in reveal accounting.

Acceptance criteria:

- User can claim one invite.
- Duplicate claim fails or returns idempotent existing claim.
- Promo funds show as shadow credit.
- Withdrawals locked until configured time.

### 12) Registration/commitment flow incomplete

Current reality:

- `DarkBoxBridge.registerAgent(...)` emits registration event.
- Full frontend/backend registration flow is not implemented.

Required actions:

- Implement registration endpoint.
- Bind owner, shadow account, agent ID/name, ENS name, instruction hash, runtime hash, reveal salt hash.
- Enforce freeze time.
- Add status to public-safe self-status endpoint.

Acceptance criteria:

- User can register before freeze.
- User cannot update after freeze unless admin policy says so.
- Commitment appears in reveal artifacts.

### 13) ENS integration placeholder

Required actions:

- Decide agent name/subname scheme.
- Decide where commitment/reveal records are written.
- Implement `darkbox-ens` service or scripts.
- Use ENS as meaningful trust/reveal component, not decoration.

Acceptance criteria:

- Agent identity links to commitment hash and reveal artifact pointer.
- Records can be verified after reveal.

### 14) Reveal bundle builder missing

Required actions:

- Implement `darkbox-reveal`.
- Export chain/deploy metadata.
- Export market/order/fill/position/PnL/accounting data.
- Export deposits, promo credits, withdrawals, settlement roots.
- Export agent action logs and runtime/model metadata.
- Export instruction preimages only if product rules allow.
- Write replay-friendly event timeline.

Acceptance criteria:

- One command builds a reveal bundle.
- Bundle can drive replay UI/video.
- Bundle contains enough accounting to audit public USDC vs shadow balances.

### 15) Frontend package for Kristel/Nicolai should be upgraded to OpenAPI

Current reality:

- `handover/dan/frontend/README.md` describes endpoints and examples.
- It is not a formal `openapi.yaml` yet in this docs-only pass.

Required actions:

- Convert the frontend README endpoint contract into `handover/dan/frontend/openapi.yaml`.
- Include public indexer, self-status, invite, whisper, deposit, registration, withdrawal endpoints.
- Mark internal endpoints explicitly out of scope.

Acceptance criteria:

- Kristel/Nicolai can generate clients or mock server from spec.
- Backend and frontend agree enum names and response shapes.

## P1 — CVM / Docker completeness

### 16) Compose does not include every intended service

Current compose is missing:

- `darkbox-transcriber`
- `darkbox-telegram-miniapp`
- future `darkbox-signer`

Required actions:

- Add services only after packages/Dockerfiles exist or as honest stubs.
- Keep networks correct:
  - transcriber: hidden, optional egress
  - miniapp: public, optional egress
  - signer: hidden/confidential only

Acceptance criteria:

- `docker compose config` clean.
- Local stack can run useful smoke tests.
- Placeholder services are labeled as placeholders.

### 17) Placeholder Dockerfiles need real runtimes

Current placeholder/weak areas:

- `infra/node`
- `apps/frontend`
- `services/agents`
- `services/bridge`
- `services/ens`
- `services/reveal`
- missing `services/transcriber/Dockerfile`

Required actions:

- Use `services/indexer/Dockerfile` as pattern for TypeScript services.
- Keep runtime images small.
- Avoid installing dev secrets into images.
- Add healthchecks where useful.

Acceptance criteria:

- Each claimed deployed service actually starts and serves/works.
- Containers exit loudly on missing required env.

### 18) Phala/CVM deployment proof missing

Required actions:

- Pick first CVM target: transcriber and signer.
- Build images.
- Define secrets injection.
- Define egress allowlist.
- Produce attestation/deployment notes.
- Run local equivalent before CVM deploy.

Acceptance criteria:

- Dan can explain what is confidential and how it is protected.
- Logs/attestation are retrievable.
- Public cannot bypass CVM boundary.

## P2 — Demo polish and marketing collateral

### 19) Replay video/data plan not implemented

Required actions:

- Generate event timeline from agent logs/indexer/reveal data.
- Build or script a replay animation.
- Show opened box: trades, players joining, new markets, leaderboard movement.
- For judges, fake replay is acceptable as pitch collateral if final audit/reveal truth remains separate.

Acceptance criteria:

- 60–90 second clip exists.
- It tells the story clearly without needing live system reliability.

### 20) Sponsor-judge market copy and demo beats need prep

Required actions:

- Include $5 signup bonus copy.
- Include hedge explanation.
- Include sponsor line: “I'll create a market for your project. If less than 10 projects use your SDK, at least you'll earn some money. Hedging!”
- Prepare QR/link flow to Mini App.

Acceptance criteria:

- Dan can pitch in under 30 seconds.
- Judges can join without reading docs.

### 21) Market resolution grammar needs enforcement in product/admin tooling

Current reality:

- Spec defines allowed ETHGlobal and Daemonhall market families.
- Indexer README documents accepted/rejected grammar.

Required actions:

- Implement market validation policy.
- Reject subjective/unresolvable markets unless explicitly AdminManual.
- Generate resolution dossiers.

Acceptance criteria:

- Agent cannot create unresolvable spam markets freely.
- Resolution dossier is reproducible enough for audit.

## Suggested owner split

### Dan

- Product/security decisions.
- Key custody approval.
- Which MVP auth path: Telegram-only vs Telegram + wallet.
- Whether withdrawals are enabled during demo or deferred.
- Which chains are real: Base only vs Base + Arc.
- Sponsor/demo messaging.

### Dan's backend agent

- Bridge service.
- Signer service.
- Transcriber service.
- Docker/CVM packaging.
- Indexer persistence/ingestion.
- Contract deploy scripts.

### Dan's contracts/security agent

- Market factory/split-join contracts.
- Frontier integration.
- Foundry tests.
- Audit/fix/rerun.
- Deployments to Base Sepolia/hidden chain.

### Kristel/Nicolai/frontend

- Telegram Mini App UX.
- Public frontend/leaderboard/reveal UI.
- Whisper confirmation UX.
- Invite claim and self-status UX.
- Replay presentation.

## Recommended immediate next checklist

If Dan has only a few hours:

1. Decide: withdrawals enabled in demo or explicitly disabled until after live play.
2. Decide: Telegram-only auth for MVP.
3. Get Base Sepolia deployer key funded.
4. Run contract tests.
5. Deploy public bridge + mock/known USDC on Base Sepolia.
6. Make transcriber runnable or replace voice with typed instructions for demo.
7. Remove/protect Mini App internal snapshot behavior.
8. Run fake random/Venice agents to produce activity feed.
9. Build replay video from fake activity if real chain integration slips.
10. Prepare final “what is real vs demo shim” note for internal team honesty.
