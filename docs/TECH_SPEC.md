# DarkBox Technical Specification

Status: finalized handoff spec for coding agents  
Last updated: 2026-06-13  
Repository: `TeeSQL/darkbox`  
Primary local workflow: Docker Compose

## 1. Product Thesis

DarkBox is a sealed agent prediction-market arena.

Users deposit USDC, register an agent, and give that agent private instructions. During live play, agents trade prediction markets inside a hidden execution environment backed by Frontier CLOB/orderbook contracts. The public can see a lively leaderboard, visible market list, and aggregate market activity stats. Per-agent balances, orderbooks, trades, positions, prompts, agent actions, and chain state stay hidden until the reveal.

At the end, the box opens: chain history, commitments, agent actions, market state, and settlement artifacts are published so the game can be audited and replayed.

Core promise:

> A sealed, verifiable agent economy where prediction-market strategy is hidden during play and auditable after reveal.

## 2. MVP Scope

### 2.1 Must Ship

- Local-first Docker Compose stack with every runtime component containerized.
- Hidden Reth/Geth devnet or equivalent local EVM chain.
- Frontier-compatible prediction-market contracts deployed inside the hidden chain.
- Standalone indexer service with internal and public API surfaces.
- Agent runner service that reads constrained observations and submits trades.
- Public frontend that never touches hidden RPC or privileged APIs.
- USDC funding/registration architecture with one concrete onboarding path and a direct Base USDC fallback.
- ENS identity/commitment integration that is meaningful, not cosmetic.
- Leaderboard exposing public-safe PnL/rank data plus aggregate activity stats that prove the market is alive without leaking per-agent balances or positions.
- Reveal bundle builder for post-game audit/replay.
- Clear security boundaries that coding agents can enforce while building.

### 2.2 Should Ship If Time Allows

- One sponsor-aligned deposit adapter: Blink, Privy, Dynamic/Fireblocks, LI.FI, or Arc.
- CVM or TEE deployment proof/attestation around the same Docker topology.
- Replay UI that can scrub through revealed trades and leaderboard changes.
- Per-agent sandbox containers instead of one shared agent runner.

### 2.3 Explicit Non-Goals

- Production-grade decentralized confidential consensus.
- Permissionless cross-chain bridge custody.
- Forced liquidation withdrawals from open positions.
- Public access to hidden node, privileged indexer data, orderbooks, raw trades, per-agent positions/balances, or agent prompts.
- General-purpose prediction-market protocol beyond this hackathon arena.
- Perfect LLM sandboxing against all possible provider/model leaks.

## 3. Hard Invariants

These are non-negotiable. Coding agents should treat any violation as a bug.

- Public frontend talks only to public APIs.
- Public frontend never connects to hidden node RPC.
- Hidden node RPC is private-network only.
- Indexer is a standalone service, not a thin frontend proxy.
- Indexer owns all derived market state: orders, fills, positions, balances, PnL, leaderboard snapshots, reveal exports.
- Indexer has separate internal and public API surfaces.
- Public API exposes only visible game data: public leaderboard/PnL, market list/metadata, aggregate activity stats, reveal status, and authenticated self-status.
- Agents cannot send messages outward during play.
- Agents cannot call arbitrary tools or fetch arbitrary URLs unless explicitly allowed by runtime policy.
- Agents receive observations only through constrained internal indexer endpoints and approved external context feeds.
- Real USDC stays in the public escrow/onboarding layer; hidden chain uses synthetic game credit.
- Deposits are idempotent; the same public funding event must never mint hidden credit twice.
- Withdrawals are disabled during live play.
- Registration and instruction commitments freeze before game start.
- All state needed for audit must be included in the reveal bundle.
- Local Docker Compose is the source of truth for service boundaries.

## 4. Visibility Model

### 4.1 Visible During Game

Public:

- Game metadata: title, rules, schedule, resolution policy, reveal policy.
- Eligible hackathon projects/teams, if known.
- Leaderboard:
  - agent display name / ENS name
  - rank
  - current PnL
  - optional drawdown
  - last update time
  - simulated/realtime-feeling UI interpolation between public snapshots
- Public market list and market metadata.
- Aggregate market activity stats:
  - total deposits
  - total trades
  - total volume, if available
  - total positions opened/closed
  - total active markets
  - total active agents
- Reveal countdown/status.

Private to the registered user:

- Their deposit/funding status.
- Their own registration status.
- Their own agent identity.
- Their instruction commitment hash.
- Their own high-level agent health status.
- Their own balance if the product chooses to show it; per-agent balances are not public.

Shared external context for all agents:

- Hackathon project submissions list.
- Project/team metadata.
- Limited market-relevant public context.
- Optional ETH/USDC price feed if the trading surface needs it.

### 4.2 Hidden During Game

- Full chain state.
- Hidden node RPC.
- Orderbooks.
- Raw trades/fills.
- Per-agent positions.
- Per-agent balances.
- Open orders.
- Per-agent/per-market PnL breakdown.
- Agent prompts/instructions.
- Agent reasoning traces.
- Agent actions before they become revealed transactions.
- Internal indexer APIs.
- Bridge/coordinator keys.

### 4.3 Revealed After Game

- Hidden chain blocks or equivalent execution trace.
- Final state root and state dump.
- Contract addresses and deployment metadata.
- Agent transactions.
- Market creation history.
- Orders/fills/positions/PnL exports.
- Initial deposits mapped to agents.
- Registration commitments and reveal preimages.
- Agent instruction preimages, unless product rules allow users to keep strategies private post-game.
- Prompt/model/runtime metadata.
- Resolution transaction(s).
- Settlement root/proofs.
- Replay data.

## 5. Repository Layout

```text
apps/
  frontend/        Public web UI. Talks only to public APIs.

services/
  indexer/         Hidden-chain indexer, internal APIs, public leaderboard APIs.
  agents/          Agent prompts, wallets, model loop, action validation, tx submission.
  bridge/          Deposits, hidden credits, settlement coordination.
  ens/             ENS subnames and commitment/reveal record updates.
  reveal/          Reveal export, replay bundle, settlement artifacts.

infra/
  node/            Hidden Reth/Geth chain container and chain config.

packages/
  shared/          Shared TypeScript types, schemas, config helpers.

docs/
  TECH_SPEC.md                    This spec.
  DEPOSITS_WITHDRAWALS_SPEC.md    Detailed funding/refund/settlement spec.
```

## 6. Runtime Architecture

### 6.1 Services

#### `darkbox-node`

Purpose: hidden EVM chain.

Responsibilities:

- Run Reth or Geth in devnet/private mode.
- Own chain data directory.
- Expose JSON-RPC only on the private Docker network.
- Host Frontier/orderbook contracts and game accounting contracts.
- Accept transactions from bridge/coordinator and agent runner.

Must not:

- Expose public RPC.
- Be reachable from frontend.
- Serve as the public query API.

#### `darkbox-indexer`

Purpose: canonical derived state service.

Responsibilities:

- Ingest hidden-chain blocks, events, logs, and transactions.
- Maintain indexed tables for:
  - agents
  - markets
  - orders
  - fills
  - positions
  - balances
  - deposits/credits
  - realized PnL
  - unrealized PnL
  - leaderboard snapshots
  - reveal exports
- Expose internal APIs for agents, bridge, and reveal service.
- Expose public APIs for frontend.
- Enforce visibility filtering.
- Provide reveal export material after game end.

Must not:

- Leak hidden data through public endpoints.
- Require agents/frontend to scan hidden RPC directly.

#### `darkbox-agents`

Purpose: autonomous trading runtime.

Responsibilities:

- Load registered agents, wallets, instructions, runtime config, and policy.
- Query constrained observations from internal indexer endpoints.
- Query approved shared external context feeds.
- Generate candidate actions through model/provider calls.
- Validate actions against schemas and game rules.
- Sign and submit hidden-chain transactions.
- Store enough logs for reveal/audit without exposing them during play.

Must not:

- Send outward chat/messages during live play.
- Expose prompts/reasoning to public APIs.
- Fetch arbitrary unapproved URLs by default.
- Bypass the indexer visibility policy.

#### `darkbox-bridge`

Purpose: asset bridge coordinator between public escrow and the shadow EVM.

Responsibilities:

- Watch direct ETH sends, direct USDC transfers, explicit deposit calls, and provider/composed funding events.
- Normalize funding events into idempotent deposit operation ids.
- Resolve onchain owner wallet to shadow account mapping.
- Mint corresponding shadow assets inside the shadow EVM after confirmed deposits.
- Accept user-signed withdrawal commands.
- Force a shadow-EVM burn/transfer of withdrawable available balance.
- Request signing-service authorization after shadow burn confirmation.
- Support multisig emergency withdrawals.

Detailed behavior lives in `docs/DEPOSITS_WITHDRAWALS_SPEC.md`.

Must not:

- Liquidate positions or cancel orders implicitly to satisfy withdrawals.
- Credit shadow balances from mempool-only events.
- Double-credit duplicate deposit/provider events.
- Release public escrow funds before the matching shadow burn/transfer is confirmed.

#### `darkbox-ens`

Purpose: identity and commitment namespace.

Responsibilities:

- Register or update agent ENS/subnames.
- Write pre-game commitment records.
- Write post-game reveal records.
- Link agent identity to commitments and reveal artifacts.

ENS should be used as part of the trust/reveal model, not as branding decoration.

#### `darkbox-frontend`

Purpose: public product surface.

Responsibilities:

- Landing/onboarding experience.
- Registration and instruction entry.
- Funding flow UI.
- Leaderboard.
- User status dashboard.
- Reveal/replay UI after game end.

Must not:

- Call hidden node RPC.
- Call internal indexer endpoints.
- Embed private API URLs or privileged tokens.

#### `darkbox-reveal`

Purpose: final audit package builder.

Responsibilities:

- Export hidden chain data.
- Export indexed events and derived state.
- Export commitments and preimages.
- Export agent runtime logs according to reveal policy.
- Export deposit/withdrawal accounting and shadow burn/mint trace.
- Build replay data.
- Stage/publish final bundle.

### 6.2 Supporting Services

- `darkbox-db`: Postgres for indexed state and metadata.
- `darkbox-cache`: optional Redis for locks/scheduling.
- `darkbox-attester`: optional Chainlink/Phala/CVM attestation adapter.
- `darkbox-object-store`: optional MinIO or equivalent for reveal bundle staging.

## 7. Docker and Network Model

Docker Compose is authoritative for service boundaries.

Required networks:

- `hidden_net`
  - internal-only
  - includes node, indexer, agents, bridge, reveal, db
  - carries hidden RPC and privileged APIs

- `public_net`
  - includes frontend and public side of indexer
  - only public-safe traffic

- `egress_net`
  - for services that need external chain/provider/model access
  - bridge, ens, agents if model calls happen directly, reveal if publishing externally

Recommended rule:

- Prefer one service per container.
- Avoid host-level dependencies.
- Use mounted volumes only for chain data, DB data, and reveal artifacts.
- Inject secrets through environment/secret files; never bake them into images.
- Keep local Compose and CVM Compose as close as possible.

## 8. Data Model

Implementation can evolve, but services should converge on these conceptual entities.

### 8.1 Game

Fields:

- `gameId`
- `status`: `draft | registration_open | frozen | live | halted | revealing | resolved | cancelled`
- `title`
- `description`
- `startsAt`
- `endsAt`
- `registrationFreezeAt`
- `resolutionRules`
- `revealPolicy`
- `settlementChainId`
- `escrowAddress`
- `hiddenChainId`

### 8.2 Agent

Fields:

- `agentId`
- `gameId`
- `ownerAddress`
- `ensName`
- `displayName`
- `walletAddressHidden`
- `instructionHash`
- `runtimeHash`
- `revealSaltHash`
- `shadowAccount`
- `totalDeposited`
- `withdrawableAvailableBalance`
- `status`: `draft | mapped | funded | active | halted | finalized`
- `createdAt`
- `updatedAt`

### 8.3 Market

Fields:

- `marketId`
- `creatorAgentId`
- `question`
- `description`
- `outcomes`
- `collateralAsset`
- `createdAt`
- `resolveBy`
- `status`: `open | paused | resolved | voided`
- `resolutionSource`
- `resolutionOutcome`

MVP should start with binary YES/NO markets.

Detailed contract source of truth: `docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md`. Use it for the market factory, binary market lifecycle, split/join vault, outcome token, Frontier integration, events, invariants, and tests.

### 8.4 Order

Fields:

- `orderId`
- `marketId`
- `agentId`
- `side`: `buy | sell`
- `outcome`
- `price`
- `size`
- `remainingSize`
- `status`: `open | partially_filled | filled | cancelled | expired`
- `txHash`
- `createdAt`

### 8.5 Fill

Fields:

- `fillId`
- `marketId`
- `makerOrderId`
- `takerOrderId`
- `makerAgentId`
- `takerAgentId`
- `outcome`
- `price`
- `size`
- `txHash`
- `blockNumber`
- `timestamp`

### 8.6 Position

Fields:

- `agentId`
- `marketId`
- `outcome`
- `quantity`
- `avgEntryPrice`
- `realizedPnl`
- `unrealizedPnl`
- `markPrice`
- `updatedAt`

### 8.7 LeaderboardSnapshot

Fields:

- `gameId`
- `rank`
- `agentId`
- `displayName`
- `ensName`
- `startingBalance`
- `currentBalance`
- `pnl`
- `drawdown`
- `updatedAt`

Public API may expose this entity only after applying visibility filters.

## 9. API Contracts

Use `packages/shared` for schemas/types. Prefer Zod or another runtime validator for all request/response boundaries.

### 9.1 Public Indexer API

Base path: `/public`

Allowed endpoints:

- `GET /public/health`
- `GET /public/game`
- `GET /public/leaderboard`
- `GET /public/markets`
- `GET /public/markets/:marketId`
- `GET /public/activity`
- `GET /public/agents/:agentId/status`
- `GET /public/reveal/status`
- `GET /public/reveal/bundle` after reveal only

Public leaderboard/activity may expose:

- per-agent public PnL and rank
- public market list and market metadata
- aggregate total deposits
- aggregate number of trades
- aggregate total volume, if available
- aggregate positions opened/closed
- aggregate active agents/markets
- snapshot timestamps

Forbidden on public API:

- per-agent balances
- orderbook depth
- open orders
- raw fills/trade stream
- per-agent positions
- per-agent/per-market PnL breakdown
- hidden chain tx stream before reveal
- prompts/instructions
- internal agent logs

### 9.2 Internal Indexer API

Base path: `/internal`

Allowed consumers: agents, bridge, reveal service, trusted operator tooling.

Endpoints:

- `GET /internal/health`
- `GET /internal/game`
- `GET /internal/agents`
- `GET /internal/agents/:agentId/state`
- `GET /internal/agents/:agentId/observations`
- `GET /internal/markets`
- `GET /internal/markets/:marketId`
- `GET /internal/markets/:marketId/orderbook`
- `GET /internal/agents/:agentId/orders`
- `GET /internal/agents/:agentId/fills`
- `GET /internal/agents/:agentId/positions`
- `GET /internal/leaderboard/raw`
- `GET /internal/reveal/export`

Internal endpoints are privileged and hidden from the public. Agents are intended to have full visibility of the indexer/internal market state: markets, orderbooks, fills, positions, balances, raw leaderboard, billboard messages, and approved market proposals. The boundary is not that agents see little; the boundary is that agents cannot leak hidden state outward except through explicitly allowed in-game actions.

### 9.3 Bridge API

Base path: `/bridge`

Public-safe endpoints:

- `POST /bridge/deposit-intents` optional helper for app/composed flows
- `GET /bridge/deposits/:depositOpId`
- `GET /bridge/accounts/:owner`
- `GET /bridge/withdrawable/:owner`
- `POST /bridge/withdrawals/commands` for user-signed withdrawal commands
- `GET /bridge/withdrawals/:withdrawalId`

Internal endpoints:

- `POST /bridge/admin/reconcile-deposits`
- `POST /bridge/admin/reconcile-withdrawals`
- `POST /bridge/admin/retry-shadow-mint`
- `POST /bridge/admin/retry-shadow-burn`
- `POST /bridge/admin/sign-withdrawal`

### 9.4 Agent Turn Output Schema

Agents act once per scheduled turn. A turn may contain multiple actions across three lanes:

1. trading actions
2. one optional public billboard post
3. one optional market proposal

Agents should output structured actions only. Free-form text is allowed for internal reasoning logs but must not drive execution directly.

Top-level turn output:

```json
{
  "tradeActions": [],
  "billboardPost": null,
  "marketProposal": null,
  "reason": "optional private note for reveal logs"
}
```

#### Trading Actions

Trading actions cover the full Frontier-style lifecycle. Use exact contract naming once ABIs are wired, but the runtime should normalize these conceptual actions:

```json
{
  "type": "make_order",
  "marketId": "string",
  "side": "buy | sell",
  "outcome": "YES | NO",
  "price": "decimal-string",
  "size": "decimal-string",
  "timeInForce": "GTC | IOC | FOK"
}
```

```json
{
  "type": "take_order",
  "marketId": "string",
  "orderId": "string",
  "size": "decimal-string",
  "maxPrice" : "decimal-string optional",
  "minPrice" : "decimal-string optional"
}
```

```json
{
  "type": "cancel_order",
  "orderId": "string"
}
```

```json
{
  "type": "split",
  "marketId": "string",
  "amount": "decimal-string"
}
```

```json
{
  "type": "merge",
  "marketId": "string",
  "amount": "decimal-string"
}
```

```json
{
  "type": "claim",
  "marketId": "string",
  "outcome": "YES | NO",
  "amount": "decimal-string optional"
}
```

```json
{
  "type": "update_position",
  "marketId": "string",
  "intent": "reduce | rebalance | close",
  "maxSlippageBps": 100
}
```

```json
{
  "type": "hold",
  "reason": "string"
}
```

`update_position` is a runtime convenience action. The executor should translate it into concrete split/merge/make/take/cancel calls or reject it if it cannot produce a safe deterministic transaction plan.

#### Billboard Action

Each agent may post at most once per turn to the public billboard.

```json
{
  "message": "string, max length configured by game rules"
}
```

Billboard messages are public during live play. They are the only intentional outward communication channel for agents. They may be strategic, taunting, vague, or misleading, but validation should block direct leaks of raw hidden state if product rules require that.

Agents can read billboard messages posted since their previous turn as part of their full indexer observation.

#### Market Proposal Action

Agents may propose a new market, but proposals do not become tradable automatically. They require admin approval.

```json
{
  "question": "string",
  "description": "string",
  "outcomes": ["YES", "NO"],
  "resolveBy": "iso-date",
  "resolutionSource": "string",
  "rationale": "string"
}
```

Proposal lifecycle:

```text
proposed -> approved -> deployed
         -> rejected
         -> expired
```

Only approved proposals are deployed to the hidden market factory.

Validation rules:

- Reject unknown action types.
- Reject malformed decimals.
- Reject prices outside market bounds.
- Reject size above available balance/risk limit.
- Reject claim before resolution.
- Reject split/merge/claim if the market/account state is incompatible.
- Reject more than one billboard post per turn.
- Reject billboard messages that exceed length/content policy.
- Reject market proposals after the allowed proposal window.
- Reject market proposals missing a resolution source.
- Log rejected actions for reveal/audit.

## 10. Deposits, Withdrawals, and Shadow Assets

The public bridge contract custodies real assets. The shadow EVM holds corresponding shadow assets used by agents for trading. Users may deposit any time and may withdraw withdrawable available balance any time, but cannot force liquidation of positions.

Use `docs/DEPOSITS_WITHDRAWALS_SPEC.md` as the detailed source for:

- direct ETH sends and direct USDC transfer detection
- approve + `deposit(asset, amount, beneficiary)` flows
- cross-chain/composed deposit compatibility
- owner wallet to shadow account mapping
- idempotent shadow minting
- withdrawable available balance rules
- user-signed withdrawal commands
- forced shadow burn/transfer before public withdrawal
- signing-service withdrawal authorization
- multisig emergency withdrawals
- failure recovery

MVP decisions:

- Canonical asset: USDC; ETH optional if useful.
- Preferred public chain: Base unless sponsor requirements dictate otherwise.
- Direct sends/transfers to the bridge must be detected offchain.
- Explicit `deposit(...)` is supported for app UX and LI.FI-style composed flows.
- Shadow assets mint 1:1 against confirmed public deposits.
- Withdrawals use user signature + shadow burn + signing-service authorization.
- No Merkle claims for normal withdrawals.
- Emergency withdrawals remain multisig/admin-only.

## 11. ENS Identity and Commitments

ENS should make the reveal/audit model clearer.

Recommended naming:

```text
<agent>.darkbox.eth
```

or, if unavailable for hackathon timing:

```text
<agent>.<controlled-parent>.eth
```

Pre-game ENS text records can include:

- `darkbox:gameId`
- `darkbox:agentId`
- `darkbox:instructionHash`
- `darkbox:runtimeHash`
- `darkbox:depositCommitment`
- `darkbox:revealSaltHash`
- `darkbox:rulesUri`

Post-reveal records can include:

- `darkbox:revealBundleUri`
- `darkbox:finalStateRoot`
- `darkbox:bridgeStatus`
- `darkbox:replayUri`

Commitment hash:

```text
instructionHash = keccak256(gameId, agentId, ownerAddress, instructions, salt)
runtimeHash = keccak256(model, toolsPolicy, systemPromptHash, actionSchemaVersion)
```

Do not store raw instructions in ENS before reveal.

## 12. Hidden Chain and Frontier Markets

### 12.1 Hidden Chain

Recommended MVP path:

- Start with a private local EVM devnet in Docker.
- Use Reth or Geth, whichever gets stable faster.
- Deploy Frontier CLOB/orderbook contracts plus any game accounting/factory contracts.
- Keep RPC reachable only on `hidden_net`.
- Later deploy the same Docker graph into CVM/TEE if available.

### 12.2 Asset Model

- Real USDC remains in public escrow.
- Hidden chain uses synthetic game credit.
- Synthetic credit exists only for gameplay accounting.
- Credit minting is restricted to bridge/coordinator key.
- Every credit references a public deposit event id.

### 12.3 Market Model

MVP market shape:

- Binary YES/NO prediction markets.
- Collateral: synthetic USDC credit.
- Initial canonical market: “Which project/team wins the hackathon?”
- Agents may create derivative markets if allowed by rules.

Market creation controls:

- fee or collateral requirement
- max markets per agent
- max question length
- no duplicate exact questions
- no markets resolving after game deadline unless explicitly allowed
- resolver/admin can void abusive markets

Split/join primitive:

- `split(amount)`: lock synthetic USDC and mint equal YES + NO claims.
- `join(amount)`: burn equal YES + NO claims and release synthetic USDC before resolution.
- `redeem(outcome, amount)`: after resolution, burn winning claims and release synthetic USDC.
- Standard terminology is split/join; `merge` may be used as an alias only if helpful for implementation compatibility.

Resolution:

- Canonical market resolved by declared hackathon winner.
- Derivative markets require explicit resolution source at creation.
- Ambiguous/invalid derivative markets can be voided.

## 13. Agent Runtime

### 13.1 Agent Loop

For each active agent:

1. Fetch full internal indexer snapshot.
2. Fetch billboard messages since this agent's previous turn.
3. Fetch approved shared external context.
4. Build strategy input from system policy, user instructions, full indexer state, billboard messages, and shared context.
5. Ask the strategy module for a structured turn output.
6. Validate each requested trade action, billboard post, and market proposal.
7. Convert valid trade actions to contract calls.
8. Sign using hidden-chain agent wallet.
9. Submit transactions to hidden node.
10. Persist billboard post if present and valid.
11. Persist market proposal for admin review if present and valid.
12. Record action, validation result, tx hash/error, and timing.
13. Sleep until next scheduling tick.

### 13.2 Observation Policy

Agents should have full visibility of the indexer/internal game state.

Agent observations should include:

- all markets visible to the indexer
- full orderbooks
- raw trades/fills
- all indexed positions and balances
- leaderboard/raw PnL state
- agent's own open orders and wallet state
- approved/pending/rejected market proposals
- public billboard messages since the agent's previous turn
- shared public context feed

Disallowed observations:

- other agents' private prompts/instructions
- other agents' private reasoning traces
- privileged operator secrets
- public escrow secrets
- bridge/coordinator keys
- withdrawal signing-service key
- model/provider API keys
- raw hidden node access beyond what the runtime/indexer intentionally provides

Important product decision:

- Agents are players inside the sealed room, so they can see the internal indexer.
- The public cannot see that internal state during live play.
- Agents may communicate outward only through the in-game public billboard, once per turn.
- Admin approval is required before proposed markets become tradable.

### 13.3 Scheduling

MVP options:

- fixed interval per agent, e.g. every 30-120 seconds
- round-robin scheduler
- random jitter to prevent deterministic first-mover advantage
- per-agent max actions per hour

Use deterministic logs so replay can explain when each agent got a chance to act.

### 13.4 Runtime Leakage Controls

- No outward messaging tools during live play except the in-game billboard action.
- Billboard posts are rate-limited to one per agent turn.
- Billboard content should pass length/content validation before publishing.
- No arbitrary browser/web-fetch unless explicitly part of shared context fetcher.
- Model output must be parsed as turn/action schema.
- Free-form model text is never published during play unless explicitly submitted as a valid billboard post.
- Store private reasoning logs in private volume/database until reveal.
- Put provider/API keys only in service secrets.
- Consider one container/process per agent for stronger isolation if time allows.

### 13.5 Strategy Modules

Start with deterministic/random strategy modules before LLM brains.

Initial random agents:

- `random-holder`: usually holds, occasionally posts on billboard.
- `random-maker`: places random valid maker orders within balance/risk limits.
- `random-taker`: randomly takes visible liquidity when available.
- `random-split-merge`: exercises split/merge/claim paths where valid.
- `random-market-proposer`: occasionally proposes plausible binary markets for admin review.

Each random agent should use the same observation, validation, signing, billboard, and proposal pipelines that LLM agents will later use. The only thing that changes later is the strategy module/brain.

## 14. Leaderboard

Purpose: spectator surface without revealing market internals.

Inputs:

- starting hidden credit
- current mark-to-market portfolio value
- realized PnL
- unrealized PnL
- fees, if any

Public output:

- rank
- agent display/ENS name
- current PnL
- current balance or score
- drawdown if desired
- last update timestamp

Do not expose:

- positions
- market inventory
- order/fill history
- per-market PnL
- market-specific exposure

Mark price policy must be deterministic and revealed later. Options:

- last traded price
- mid-price if both sides exist
- conservative mark if thin book
- final settlement value after resolution

## 15. Reveal and Replay

### 15.1 Reveal Bundle Contents

The reveal service should produce a versioned bundle containing:

```text
manifest.json
chain/
  genesis.json
  blocks.ndjson or execution_trace.ndjson
  final_state_root.txt
contracts/
  deployments.json
  abis/
indexer/
  markets.ndjson
  orders.ndjson
  fills.ndjson
  positions.ndjson
  balances.ndjson
  leaderboard_snapshots.ndjson
agents/
  agents.json
  runtime_hashes.json
  actions.ndjson
  validation_errors.ndjson
commitments/
  registrations.ndjson
  instruction_preimages.ndjson (if reveal policy allows)
  ens_records.ndjson
bridge/
  deposits.ndjson
  shadow_mints.ndjson
  withdrawal_commands.ndjson
  shadow_burns.ndjson
  public_withdrawals.ndjson
  emergency_withdrawals.ndjson
replay/
  replay_events.ndjson
```

### 15.2 Manifest

`manifest.json` should include:

- spec version
- game id
- hidden chain id
- public escrow chain id
- escrow contract
- hidden contract addresses
- start/end/freeze timestamps
- final state root
- bridge accounting summary
- file hashes for every bundle file
- bundle creation timestamp

### 15.3 Replay UI

Replay UI should support:

- leaderboard over time
- market creation timeline
- order/fill timeline
- agent action timeline
- final deposit/withdrawal accounting view

Replay can be implemented after raw bundle export, but the export schema should anticipate it.

## 16. Attestation / Confidential AI

Desired guarantees:

- Hidden environment ran the expected containers/images.
- Agent runtime used the committed policy/runtime.
- Operator did not mutate state secretly during play.
- Reveal bundle matches hidden execution.

Practical recommendation:

- Build local Docker Compose first.
- Add image digests and runtime hashes to commitments.
- If Chainlink Confidential AI Attester is real and usable, integrate it around agent/runtime evidence.
- If not, use Phala/CVM attestation or a simpler signed operator commitment for MVP.
- Do not block core product on attestation if sponsor tooling is unstable.

## 17. Security and Abuse

### 17.1 State Leakage

Risks:

- frontend accidentally pointed to internal API
- CORS/open proxy mistake
- logs exposed publicly
- public API returns hidden fields
- source maps or env files deployed publicly

Controls:

- separate public/internal routes
- schema-level response filtering
- public API contract tests
- no public node RPC
- no secrets in frontend bundles
- no `.env` or source maps in production static output

### 17.2 Agent Prompt Injection

Risks:

- shared external context contains malicious text
- user instructions try to bypass rules
- model emits invalid/exfiltrating output

Controls:

- treat external context as data, not instructions
- strict system policy
- structured action parser
- deny unsupported tools
- action validation before signing
- log rejected actions

### 17.3 Operator Cheating

Risks:

- operator edits hidden state
- operator changes agent instructions after freeze
- operator selectively reveals data

Controls:

- pre-game commitments
- freeze transition
- deterministic logs
- signed image/runtime hashes
- reveal bundle with file hashes
- deposit/withdrawal accounting traceable to revealed shadow and public-chain events

### 17.4 Market Abuse

Risks:

- spam markets
- ambiguous derivative markets
- offensive questions
- unresolvable markets

Controls:

- creation fee/collateral
- max markets per agent
- question validation
- resolver/void path
- resolution source required at creation

### 17.5 Deposit Abuse

Risks:

- duplicate webhooks
- chain reorgs
- late deposits
- failed hidden credit tx

Controls:

- confirmations before credit
- idempotency keys
- hidden-chain event recovery before retry
- late-deposit refund path
- bridge reconciliation job

## 18. Implementation Plan

### Phase 0 — Repo Foundation

Deliverables:

- `pnpm` workspace works.
- Docker Compose builds all service containers.
- Shared config/types package exists.
- Minimal health endpoints for services.
- Public/internal network separation exists in Compose.

Acceptance checks:

- `pnpm install`
- `pnpm -r typecheck` or equivalent placeholder scripts
- `docker compose config`
- `docker compose build`

### Phase 1 — Hidden Chain and Contracts

Deliverables:

- Hidden devnet container runs locally.
- Frontier/orderbook contracts deploy in local flow.
- Game accounting/credit contract exists if needed.
- Seed script creates canonical hackathon-winner market.

Acceptance checks:

- hidden RPC reachable only inside Compose network
- deploy script outputs contract addresses
- sample order transaction succeeds

### Phase 2 — Indexer

Deliverables:

- Indexer ingests hidden chain events.
- DB schema/migrations for core entities.
- Internal API returns markets/orderbook/agent state.
- Public API returns only game and leaderboard.
- Response filtering tests prevent leaks.

Acceptance checks:

- sample events become indexed rows
- public API leak tests pass
- frontend can render leaderboard from public API only

### Phase 3 — Agent Runtime

Deliverables:

- Agent config/registration loader.
- Observation builder.
- Action schema parser/validator.
- Basic model stub or deterministic test agent.
- Transaction signer/submitter.
- Rejected action logging.

Acceptance checks:

- deterministic test agent can place/cancel orders
- invalid action is rejected and logged
- no outward messaging/fetch tools are available by default

### Phase 4 — Registration and Funding

Deliverables:

- Public escrow contract or mocked local equivalent.
- Bridge watches funding events.
- Idempotent hidden credit flow.
- Registration freeze behavior.
- Pre-freeze refund and post-freeze lock rules.

Acceptance checks:

- duplicate funding event does not double-credit
- late deposit after freeze is refundable/not credited
- hidden credit references public funding event id

### Phase 5 — ENS and Commitments

Deliverables:

- Agent identity model.
- Commitment hash generation.
- ENS/subname text record writer or mocked adapter.
- Post-reveal record update path.

Acceptance checks:

- commitment hashes are deterministic
- raw instructions are not published pre-reveal
- reveal records link to final bundle/root

### Phase 6 — Frontend

Deliverables:

- Landing/onboarding flow.
- Agent registration/instruction form.
- Funding status UI.
- Leaderboard.
- Reveal status page.
- Optional 3D dark room/terminal experience.

Acceptance checks:

- frontend uses only public API env vars
- no hidden RPC/internal URL appears in built frontend
- build output passes static secret scan before deployment

### Phase 7 — Reveal and Settlement

Deliverables:

- Reveal bundle export.
- Manifest with file hashes.
- Settlement root/proofs.
- Replay event file.
- Optional replay UI.

Acceptance checks:

- bundle can be generated from local game run
- settlement totals reconcile to escrow deposits
- replay data reconstructs leaderboard progression

### Phase 8 — CVM/Attestation

Deliverables:

- Compose stack deployable into CVM/TEE target.
- Image digests/runtime hashes captured.
- Attestation artifact, if sponsor tooling supports it.

Acceptance checks:

- same images run locally and in target environment
- public frontend still cannot reach hidden RPC
- attestation/reveal artifact references image/runtime hashes

## 19. Coding-Agent Work Packages

Use these as initial tasks for implementation agents.

### Work Package A — Compose + Service Skeleton Hardening

Goal: make the repo reliably build and run service health checks.

Scope:

- Add package scripts.
- Add minimal HTTP server/health endpoint per service.
- Add shared config loader.
- Ensure Dockerfiles build.
- Add `.env.example` values for local dev.

Done when:

- `docker compose build` succeeds.
- `docker compose up` starts all non-profile services.
- `GET /health` works where applicable.

### Work Package B — Indexer API and Schema

Goal: create the state backbone.

Scope:

- DB schema/migrations.
- Internal/public route separation.
- Shared response schemas.
- Seed/mock event ingestion before contracts are ready.
- Leak-prevention tests.

Done when:

- public leaderboard endpoint works from seeded data.
- internal market/agent endpoints work.
- tests prove hidden fields are absent from public responses.

### Work Package C — Agent Runtime MVP

Goal: random/deterministic agents can run locally using the same pipeline later used by LLM brains.

Scope:

- Full-indexer observation builder.
- Turn output schema and validator.
- Trading actions: make, take, cancel, split, merge, claim, update_position.
- Billboard read/write path with one post per turn.
- Market proposal path with admin approval queue.
- Random strategy modules: holder, maker, taker, split/merge exerciser, market proposer.
- Wallet/signer abstraction.
- Transaction submission stub or real hidden-chain path.

Done when:

- multiple random agents can take turns locally.
- agents can read full indexer state.
- agents can place/take/cancel orders where valid.
- split/merge/claim paths are exercised where valid.
- billboard messages persist and are visible to later turns.
- market proposals enter an approval queue, not automatic deployment.
- invalid actions are rejected and logged.
- action logs are stored for reveal.

### Work Package D — Bridge/Funding MVP

Goal: confirmed deposits credit hidden balances exactly once.

Scope:

- Implement deposit event model.
- Implement idempotency store.
- Implement hidden credit flow.
- Implement reconciliation job.
- Wire to direct Base escrow or local mock first.

Done when:

- duplicate event test passes.
- hidden credit event references public funding event.
- pre-freeze/late-deposit behavior matches spec.

### Work Package E — Reveal Bundle

Goal: produce audit bundle from local game.

Scope:

- Manifest format.
- Export indexed tables.
- Export agent action logs.
- Export commitments.
- Produce file hashes.

Done when:

- a local simulated game produces a complete bundle.
- bundle can be validated by a script.

## 20. Demo Script

1. Open DarkBox landing page.
2. User enters the dark-room/terminal onboarding flow.
3. User creates an agent name and whispers instructions.
4. User funds/registers agent.
5. ENS/commitment record is created.
6. Game starts.
7. Several agents trade hidden markets.
8. Public leaderboard updates, but no orderbook/trades/positions are visible.
9. At deadline, game freezes.
10. Winner/resolutions are applied.
11. Reveal bundle is generated.
12. Replay UI shows what happened inside the box.
13. Signing-service authorized withdrawals are available for withdrawable shadow balances.

## 21. Open Decisions

These should be resolved by humans or explicit project lead choice, not guessed by coding agents.

- Exact sponsor/onboarding path for the first funding adapter.
- Whether raw user instructions are revealed after the game or only their hashes/runtime metadata.
- Whether agents can create derivative markets in MVP or only trade the canonical market.
- Whether agents can see full orderbooks or only constrained market observations.
- Final CVM/TEE provider and attestation path.
- Final resolution authority for derivative markets.

## 22. Default Recommendation

For the hackathon build, optimize for a coherent end-to-end demo over maximal decentralization:

- Local-first Docker Compose stack.
- Private Reth/Geth devnet.
- Frontier contracts inside hidden chain.
- Standalone indexer with strict public/internal API split.
- Deterministic test agents first, LLM agents second.
- Base USDC escrow/direct deposit fallback.
- One sponsor onboarding adapter only.
- ENS commitments for real audit value.
- Reveal bundle before fancy replay UI.
- CVM/attestation only after the local loop is stable.
