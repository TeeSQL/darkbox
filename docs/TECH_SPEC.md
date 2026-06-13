# DarkBox Technical Specification

## 1. Product Summary

DarkBox is a sealed agent prediction-market arena built on Frontier CLOB/orderbook contracts.

Participants deposit USDC, register an agent, and give that agent private instructions. During the hackathon, the agent trades inside a hidden blockchain environment. The public can only see a leaderboard showing each agent's PnL. No one can inspect the orderbook, trades, positions, market state, or chain state until the final reveal.

At the end of the hackathon, the box opens: the hidden chain state, execution history, commitments, and agent behavior are published; markets are resolved; and winnings are settled.

The central product thesis:

> A sealed, verifiable agent economy where prediction-market strategy is hidden during play and auditable after reveal.

## 2. Design Goals

### 2.1 User Goals

- Easy entry: deposit USDC without thinking about chain complexity.
- Clear game loop: whisper instructions first, choose/receive agent identity, finalize auth/deposit, watch leaderboard.
- Strong spectator appeal: public rankings update while the actual market remains hidden.
- Trustworthy finale: reveal proves the hidden game was executed correctly.
- Memorable hackathon story: agents competing silently inside a black box.
- Atmospheric onboarding: the landing page should be a playable 3D dark room / underground labyrinth where users find terminals and whisper instructions to their agents.

### 2.2 Technical Goals

- Reuse Frontier CLOB/orderbook contracts as the trading engine.
- Run the trading engine inside a confidential or hidden execution environment.
- Prevent agents from leaking private chain state or their strategy during the game.
- Keep the public API intentionally narrow.
- Commit all relevant game inputs before play begins.
- Publish enough data at reveal to audit execution and settlement.
- Integrate bounty-relevant infra only where it strengthens the product.

### 2.3 Non-Goals for Hackathon MVP

- Fully decentralized confidential chain consensus.
- Production-grade dispute system.
- Permissionless bridge custody across many chains.
- Perfect bot sandboxing against all possible model/provider leaks.
- Polymarket-scale UX.
- General-purpose prediction-market protocol beyond this arena.

## 3. Visibility Model

### 3.1 Visible During Game

- Public leaderboard:
  - agent ENS/display name
  - current PnL
  - rank
  - optional simple stats: starting balance, current balance, drawdown, last update time
- User's own private dashboard:
  - deposited amount
  - current agent balance
  - registration status
  - instruction commitment
  - optional agent health status
- Public game metadata:
  - main market description
  - game start/end time
  - resolution rules
  - list of eligible teams/projects if known
  - final reveal policy
- Shared external context feed visible to all agents:
  - hackathon project submissions list
  - project/team metadata
  - ETH/USDC price if WETH/ETH is included in the trading surface
  - keep this intentionally small for MVP; sponsor/prize schedules, social data, and GitHub activity are stretch goals only.

### 3.2 Hidden During Game

- Full chain state.
- Orderbooks.
- Trades.
- Positions.
- Open orders.
- Agent prompts/instructions.
- Agent reasoning traces.
- Market creation activity.
- Which derivative markets exist, unless we intentionally expose market names without state.
- Per-market PnL breakdown.

### 3.3 Revealed After Game

- Hidden chain blocks or equivalent execution trace.
- Final state root and state dump.
- Contract addresses and deployment metadata.
- All transactions submitted by agents.
- Initial deposits mapped to agents.
- Agent instruction preimages, unless users explicitly opt for hidden strategy even after game.
- Prompt/model/runtime metadata.
- Market creation history.
- Resolution transaction(s).
- Settlement proof.
- Replay UI data.

## 4. High-Level Architecture

DarkBox has six major subsystems:

1. Public funding and registration layer.
2. ENS identity and commitment layer.
3. Hidden execution layer.
4. Agent runtime layer.
5. Public leaderboard/read API.
6. Reveal and settlement layer.

### 4.1 System Flow

1. User visits DarkBox frontend.
2. User signs in/connects wallet.
3. User deposits USDC using the selected onboarding/onramp flow.
4. User registers an agent:
   - chooses agent name
   - writes private instructions
   - selects model/runtime options if exposed
   - receives or configures ENS/subname identity
5. Registration creates public commitments:
   - user identity commitment
   - agent identity commitment
   - instruction hash
   - runtime hash
   - funding amount
6. Deposit is acknowledged by the coordinator.
7. Coordinator credits the agent inside the hidden chain.
8. Game starts.
9. Agent runner loops:
   - reads allowed private inputs
   - asks model for action
   - converts action to hidden-chain transaction
   - submits transaction
10. Leaderboard service computes and publishes limited PnL.
11. At deadline, trading stops.
12. Resolver resolves canonical and derivative markets.
13. Reveal publisher releases full audit bundle.
14. Settlement contract pays out or allows withdrawals.


## 4A. CVM / Docker Deployment Model

A core deployment constraint: every independent runtime component must be packaged as a Docker container so it can run inside the CVM environment with explicit networking, volumes, secrets, and attestation boundaries.

The CVM should be treated as a sealed mini-cluster. No service should rely on host-level state except mounted encrypted volumes and explicitly injected secrets.

Local Docker Compose is the source of truth for component boundaries. The goal is: if it runs locally in Compose, the same component graph can be deployed into the CVM with minimal changes.

### 4A.1 Container Topology

Minimum service set:

1. `darkbox-node`
   - Runs the hidden blockchain node: Reth or Geth.
   - Owns hidden chain data directory.
   - Exposes JSON-RPC only on the private Docker network.
   - No public RPC.
   - Optional internal admin RPC restricted to indexer/coordinator containers.

2. `darkbox-indexer`
   - Mandatory standalone service, not a thin RPC proxy.
   - Reads hidden-chain RPC/event logs/blocks continuously.
   - Maintains queryable derived state in Postgres or another indexed store.
   - Computes balances, open orders, fills, positions, realized/unrealized PnL, market metadata, and leaderboard snapshots.
   - Serves high-volume trading data to trusted internal trading bots without making them scan RPC.
   - Has two API surfaces:
     - internal API: rich/privileged indexed state for trading bots, agent runner, bridge coordinator, reveal builder.
     - external API: strictly filtered public state: leaderboard, public game metadata, reveal status.
   - Enforces the visible/hidden boundary at the API layer.

3. `darkbox-agents`
   - Owns agent wallets, prompts, runtime policy, and model calls.
   - Runs the agent loop.
   - Reads only allowed observations from `darkbox-indexer` internal constrained endpoints.
   - Submits signed transactions to `darkbox-node`.
   - Can be one container for all agents in MVP, or one container per agent if stronger isolation is needed.

4. `darkbox-bridge`
   - Watches public deposit chain / onboarding provider events.
   - Credits agents inside the hidden chain.
   - Builds withdrawal/settlement artifacts after reveal.
   - Talks to Base/Arc/onboarding provider externally, and hidden node internally.

5. `darkbox-ens`
   - Handles ENS/subname registration and record updates.
   - Writes pre-game commitment records and post-game reveal records.
   - Can be separate for clean bounty/demo boundaries, or merged into bridge/coordinator for MVP if time is tight.

6. `darkbox-frontend`
   - Public web UI.
   - Talks only to external/public API endpoints.
   - Never connects to hidden node RPC.

7. `darkbox-reveal`
   - Builds final reveal bundle.
   - Exports chain data, indexed events, agent logs, commitments, settlement tree, and replay data.
   - Can be dormant until game end.

Optional supporting containers:

- `darkbox-db`: Postgres for indexed state and app metadata.
- `darkbox-cache`: Redis for round scheduling/locks, if needed.
- `darkbox-attester`: Chainlink/Phala/CVM attestation adapter.
- `darkbox-object-store`: local MinIO for reveal bundle staging before publishing externally.

### 4A.2 Network Segmentation

Use separate Docker networks:

- `hidden_net`
  - `darkbox-node`
  - `darkbox-indexer`
  - `darkbox-agents`
  - `darkbox-bridge`
  - `darkbox-reveal`
  - no public ingress

- `public_net`
  - `darkbox-frontend`
  - external side of `darkbox-indexer`
  - reverse proxy

- `egress_net`
  - `darkbox-bridge` for public chain/provider access
  - `darkbox-ens` for ENS writes
  - `darkbox-agents` only if remote model APIs are used

The hidden node only binds to `hidden_net`. The frontend must never share a network with the hidden node.

### 4A.2B Indexer Responsibilities

The indexer is a first-class backend service. It should not be replaced by direct RPC reads. RPC is the ingestion source; the indexer is the product/query layer.

Why it is required:

- Frontier orderbook state will be awkward/expensive to reconstruct from raw RPC for every bot tick.
- Trading bots need low-latency derived views: best prices, fills, own orders, inventory, market metadata, and historical snapshots.
- PnL requires indexed fills, positions, deposits, withdrawals, fees, market resolution state, and mark/fair-value logic.
- The public leaderboard must be generated from a controlled, audited data pipeline rather than ad hoc RPC calls.
- Reveal/replay needs a complete indexed history of markets, orders, fills, and agent actions.

Core indexed tables/views:

- agents
- deposits
- internal_balances
- markets
- market_outcomes
- orders
- fills
- positions
- market_snapshots
- pnl_snapshots
- leaderboard_snapshots
- agent_actions
- settlement_claims
- external_context_snapshots

Visibility decision:

- Trading agents receive the full internal orderbook/indexer view, including markets, orders, fills, positions, prices, balances, replay-relevant events, and shared external context.
- Agent observations must be mediated by the machine/indexer. Agents do not get open internet access; they receive their own prompt/history plus the shared curated context feed.
- Human users receive only aggregate account state: available balance, estimated deployed portfolio value, total estimated equity, leaderboard rank, and PnL.
- Live PnL should use last-trade marking for MVP. Midpoint/fair-value marking can be added later as secondary display, but last trade is simpler and less gameable in thin markets.
- Leaderboard snapshots should be timed rather than every block for MVP, e.g. every 10–30 seconds plus final authoritative state at reveal.

Trusted internal consumers:

- `darkbox-agents` for agent-specific observations.
- internal market-making/trading bots for rich trading views.
- `darkbox-bridge` for deposit crediting and withdrawal settlement.
- `darkbox-reveal` for final audit bundle generation.

Public consumers:

- `darkbox-frontend`, but only through filtered external endpoints.

### 4A.3 Internal vs External APIs

`darkbox-indexer` is the main boundary service.

Internal endpoints may include:

- `GET /internal/agent/:id/observation`
- `GET /internal/agent/:id/balance`
- `POST /internal/leaderboard/snapshot`
- `GET /internal/reveal/export`
- `GET /internal/market/:id/private-state` only if needed by trusted services, never agents

External endpoints may include only:

- `GET /public/game`
- `GET /public/leaderboard`
- `GET /public/agent/:ensName`
- `GET /public/external-context`
- `GET /public/reveal/status`
- `GET /public/reveal/bundle` after reveal

`/public/external-context` is not hidden market state. It is the shared public-information feed that all agents can also consume. For MVP it should include the hackathon project submissions list and project/team metadata. If WETH/ETH is included, it should also include ETH/USDC price. Sponsor/prize schedule, social data, and GitHub activity are stretch goals.

No endpoint should accidentally expose raw transaction logs, orderbook state, positions, or hidden market details before reveal.

### 4A.4 Agent Isolation Choices

There are two acceptable MVP modes:

#### Shared Agent Runner

One `darkbox-agents` container runs all agents.

Pros:

- Fastest to build.
- Simple scheduling.
- Easier secret management.

Cons:

- Weaker isolation between agents.
- A runner bug can affect all agents.

#### Per-Agent Sandbox

Each agent runs in its own container, e.g. `darkbox-agent-<id>`.

Pros:

- Cleaner isolation.
- Per-agent CPU/memory/network limits.
- Stronger story if agents can run arbitrary-ish strategies.

Cons:

- More orchestration complexity.
- Harder in a hackathon CVM unless we prebuild a lightweight supervisor.

Recommended MVP: start with shared runner, but design the runner API so agents can later be split into one-container-per-agent without changing contracts.

### 4A.5 Secrets and Volumes

Persistent volumes:

- node chain data
- indexer DB
- agent prompt/commitment store
- reveal bundle staging

Secrets:

- hidden-chain funded coordinator key
- per-agent hidden-chain keys, if not derived/sealed internally
- public-chain bridge signer
- ENS manager key
- model/provider API keys, if remote inference is used
- onboarding provider credentials

Secrets should be injected as Docker secrets or CVM-sealed environment variables, not baked into images.

### 4A.6 Attestation Boundary

The attested unit should ideally cover:

- container image digests
- docker-compose or service manifest hash
- environment policy hash
- genesis/config hash
- agent runtime hash
- allowed network policy

At registration time, `runtimeHash` should include the relevant container image digests and service manifest hash. At reveal, the published bundle should prove that the runtime matched the pre-game commitments.


## 5. Public Funding and Registration Layer

### 5.1 Purpose

This layer is the normal user-facing entry point. It should feel simple: deposit stablecoins, name your agent, write instructions, enter the arena.

### 5.2 Bounty-Aligned Options

The best fit should be selected after checking docs and implementation complexity.

#### Option A: Blink Deposit Flow

Use Blink for one-tap stablecoin deposits.

Why it fits:

- Best product fit for “fund my game/agent account”.
- Can make deposit feel like a consumer app, not a bridge.
- Likely strongest if the bounty emphasizes onboarding, checkout, or easy stablecoin UX.

DarkBox use:

- User chooses deposit amount.
- Blink handles stablecoin pull/payment UX.
- Backend receives payment confirmation.
- Backend binds payment to agent registration.
- Coordinator credits hidden-chain account.

Risks:

- Need to confirm exact supported chains/tokens.
- Need to confirm whether it supports Base USDC or requires another settlement route.

#### Option B: Privy Universal Deposit Addresses

Use Privy embedded wallet + universal deposit addresses.

Why it fits:

- Strong cross-chain funding story.
- User can deposit from external wallet/exchange/chain.
- Very natural for “fund an agent account”.

DarkBox use:

- Privy creates user account/wallet.
- User gets deposit address.
- Deposit can arrive from multiple sources.
- Backend watches funding status.
- On confirmation, user can register/start agent.

Risks:

- Privy may pull the project toward embedded-wallet UX.
- If users are already crypto-native, embedded onboarding may be unnecessary.

#### Option C: Dynamic / Fireblocks Flow

Use Dynamic for wallet onboarding and Flow for any-wallet/any-chain deposits.

Why it fits:

- Bounty text explicitly mentions iGaming/prediction markets and agentic deposits.
- Dynamic also supports server wallets/delegated access, useful if agent signing is external.

DarkBox use:

- User signs in via Dynamic.
- User funds game from any supported wallet/exchange/chain.
- Agent wallet or coordinator wallet receives/controls funds.
- Server wallet can be used for agent-side signing if we choose not to run agent keys inside the CVM.

Risks:

- More moving parts than Blink.
- Might overcomplicate MVP if deposit is the only reason to use it.

#### Option D: LI.FI Composer Deposit Workflow

Use LI.FI Composer to make registration a single composed transaction/workflow.

DarkBox use:

- Bridge/swap into USDC.
- Deposit to entry contract.
- Register agent.
- Possibly set ENS record or submit commitment.

Why it fits:

- Great if we want a cross-chain “one flow” demo.
- Good developer story: one composed entry workflow.

Risks:

- Less product-specific than Blink/Privy/Dynamic.
- Needs careful integration to avoid being bounty garnish.

### 5.3 Recommended MVP Path

Pick one primary funding integration:

- If Blink supports our target flow cleanly: use Blink.
- Else if Privy universal deposits are fastest: use Privy.
- Else use Dynamic if server wallets help agent signing too.

Do not integrate all of them. The deposit story should be one clean path, plus maybe one fallback manual Base USDC deposit for demo reliability.

### 5.4 Public Entry Contract

A public contract records entry commitments and deposits.

Responsibilities:

- Accept or acknowledge USDC funding.
- Register participant and agent identity.
- Store commitment hashes.
- Emit events for backend/coordinator.
- Freeze registration at game start.
- Provide withdrawal/settlement hooks after reveal.

Candidate interface:

```solidity
function registerAgent(
    bytes32 agentId,
    string calldata ensName,
    bytes32 instructionHash,
    bytes32 runtimeHash,
    bytes32 revealSaltHash
) external;

function depositForAgent(bytes32 agentId, uint256 amount) external;

function freezeRegistration(bytes32 gameId) external;

function publishFinalRoot(bytes32 gameId, bytes32 hiddenChainRoot, bytes32 revealBundleHash) external;

function claim(bytes32 agentId, bytes calldata proof) external;
```

## 6. ENS Identity and Commitment Layer

### 6.1 Product Role

ENS should not be a cosmetic display name. It should be the stable public namespace binding each agent to its commitments and reveal artifacts.

DarkBox ENS identity answers:

- Who is this agent?
- What did it commit to before the game?
- Where is the reveal/audit bundle after the game?
- Is this the same agent across leaderboard, funding, settlement, and replay?

### 6.2 ENS Naming Model

Possible namespace:

- `darkbox.eth` parent name.
- Agent subnames:
  - `alice.darkbox.eth`
  - `ocean.darkbox.eth`
  - `agent17.darkbox.eth`

If the project cannot control `darkbox.eth`, use a hackathon-owned ENS name or testnet-equivalent namespace.

The ENS/display name should be chosen or assigned when the user starts playing, immediately after the initial whisper flow and before/alongside deposit finalization. It should appear in the leaderboard from the beginning so the agent has a stable public identity throughout onboarding, funding, gameplay, and reveal.

### 6.3 ENS Records

Primary ENS use case: encrypted agent instructions and commitment/reveal pointers.

During the game, the ENS record should point to a manifest URI/hash. The manifest should include agent identity, encrypted current-instructions blob URI/hash, instruction commitment hash, public key or encryption scheme, game/rules version, and reveal policy.

Each mid-game instruction update creates a new encrypted blob and commitment version. Public observers can verify that instructions were committed, but cannot read plaintext before reveal. The sealed runtime/CVM can decrypt or access plaintext through the configured key path.

After reveal, ENS can point to the final reveal bundle. Plaintext instructions may be published fully or selectively depending on the game rules and user consent.

Pre-game records:

- `addr`: public owner or agent registration contract.
- `text:darkbox.agentId`: canonical `bytes32` agent id.
- `text:darkbox.gameId`: game id.
- `text:darkbox.instructionHash`: hash of private instructions.
- `text:darkbox.runtimeHash`: hash of agent runtime/container/model config.
- `text:darkbox.depositTx`: deposit transaction reference.
- `text:darkbox.entryCommitment`: aggregate commitment hash.

During-game records:

- Mostly unchanged.
- Optional `text:darkbox.status`: active/eliminated/frozen.
- `text:darkbox.instructionsEncrypted`: URI/hash of the latest encrypted instruction blob.
- `text:darkbox.instructionVersion`: monotonic instruction update version.
- Do not publish plaintext instructions or private market state.

Post-reveal records:

- `text:darkbox.revealBundle`: URI to reveal bundle.
- `text:darkbox.finalPnl`: final PnL or pointer to final settlement proof.
- `text:darkbox.replay`: URI to replay UI.
- `text:darkbox.finalStateRoot`: final hidden-chain state root.

### 6.4 Commitment Scheme

Each agent has an entry commitment:

```text
entryCommitment = keccak256(
  gameId,
  ownerAddress,
  ensName,
  depositAmount,
  instructionHash,
  runtimeHash,
  modelConfigHash,
  salt
)
```

Instruction hash:

```text
instructionHash = keccak256(canonicalInstructionJson)
```

Runtime hash:

```text
runtimeHash = keccak256(containerImageDigest, runnerVersion, modelIdentifier, policyConfig)
```

Reveal bundle hash:

```text
revealBundleHash = keccak256(all_blocks_or_trace, state_dump, instructions, runtime_manifest, settlement_report)
```

### 6.5 Why ENS Improves the Product

ENS creates a user-facing, verifiable continuity layer:

- The leaderboard is readable.
- Agent commitments are discoverable without trusting our UI.
- The reveal can be independently tied back to the pre-game identity.
- It gives agents a durable name and reputation surface beyond the hackathon.

This is a much better ENS story than “we resolved a name to an address”.

## 7. Hidden Execution Layer

### 7.1 Purpose

The hidden execution layer runs the actual prediction market game. It must preserve game secrecy during play while producing an auditable record afterward.

### 7.2 Execution Options

#### Option A: CVM running Reth or Geth

Use a confidential VM to run a private Ethereum node.

Pros:

- Familiar EVM stack.
- Frontier contracts run with minimal changes.
- Strong story: full blockchain inside a sealed box.
- Easier replay if we preserve blocks/state.

Cons:

- Need credible attestation story.
- Need to control RPC access tightly.
- Hidden chain is centralized unless we build more.

#### Option B: Phala TEE Runtime

Use Phala if Chainlink Confidential AI is insufficient or if we need stronger confidential compute primitives quickly.

Pros:

- Purpose-built confidential compute / agent runtime story.
- Better if AI execution must be confidential and attestable.

Cons:

- More unfamiliar moving parts.
- Frontier chain still needs either embedded EVM or external hidden node.

#### Option C: Simple Private Devnet for MVP

Run a locked-down Reth/Geth node without full confidential guarantees, but commit to logs/state and present as a prototype.

Pros:

- Fastest.
- Demo reliable.

Cons:

- Weaker security story.
- Bounty/judge skepticism if “hidden” just means “we did not expose RPC”.

### 7.3 Recommended MVP Path

Use a sealed Reth/Geth devnet as the core, then add one attestation layer:

- If Chainlink Confidential AI Attester can attest model inference or confidential processing meaningfully, integrate it around agent decisions.
- If not, use Phala or another TEE attestation for the agent runner / chain coordinator.

For the hackathon, it is acceptable if the hidden chain is operator-run, as long as:

- inputs are committed before play,
- outputs are revealed,
- replay verifies the published result,
- the demo clearly distinguishes MVP trust assumptions from future decentralization.

### 7.4 Hidden Chain Setup

- Client: Reth preferred if familiar/performant; Geth acceptable for simplicity.
- Chain ID: custom DarkBox chain id.
- Native gas: fake/dev ETH or gasless relayer.
- Core token: internal wrapped USDC mirror.
- Contracts:
  - Frontier CLOB book/factory/router/lens.
  - Prediction market factory.
  - Agent account registry.
  - Internal settlement accounting.
  - Resolver.

### 7.4B Asset Model

Canonical accounting unit: USDC.

MVP rules:

- Base USDC is the required deposit/settlement asset.
- Minimum deposit: $10.
- PnL leaderboard is normalized to USDC.
- WETH/ETH support is a stretch goal trading asset. It creates more market surface and may help the Uniswap/bounty story, but it must not block MVP.
- If users deposit ETH, mirror it internally as WETH.
- If WETH/ETH is included, add ETH/USDC price to the shared external context feed.
- Multi-asset support must not block the MVP: USDC-only fallback must always work.

### 7.5 State Ingress

Public deposits are mirrored into the hidden chain by the coordinator.

Ingress event:

```text
DepositConfirmed {
  gameId,
  agentId,
  amount,
  sourceChain,
  sourceTx,
  entryCommitment
}
```

Coordinator action:

- Mints/credits internal USDC to agent account on hidden chain.
- Records source deposit reference.
- Emits hidden-chain `AgentFunded` event.

### 7.6 State Egress

During game, egress is limited to leaderboard values.

Allowed public outputs:

- agent id/name
- total current equity
- PnL
- rank
- timestamp/root reference

Forbidden public outputs:

- per-market balances
- order/trade events
- hidden market list if derivatives are meant to be secret
- open orders
- counterparties
- agent action logs

## 8. Frontier Prediction Market Contracts

### 8.1 Core Market Model

The initial market predicts hackathon winner.

For each candidate/project/team:

- YES token/book.
- Optional NO token/book or synthetic complement logic.
- Prices represent probability or payout ratio.
- Collateral: USDC.

MVP can support:

- Main winner market.
- Top-N market if simple.
- Permissionless derivative market creation.

### 8.2 Market Factory

Agents can create derivative markets in the same hidden game universe as the canonical market.

Derivative topology:

- One CVM / hidden chain for the whole game.
- One canonical main market: hackathon winner.
- Derivatives are connected markets inside the same hidden chain/orderbook, not separate CVMs.
- They share the same information boundary: hidden trading state, public leaderboard only.
- Derivatives may reference the main market, project/team metadata, or other objectively resolvable hackathon facts.

Market examples:

- “Will Team X place top 3?”
- “Will an AI agent project win?”
- “Will a DeFi project win?”
- “Will the winner use confidential compute?”
- “Will the final winner have more than N GitHub commits?”

Factory responsibilities:

- Create market metadata.
- Create associated Frontier books.
- Define resolver type.
- Set collateral rules.
- Charge market creation fee if needed.
- Store market creator.

### 8.2B Open YES/NO Market Creation

Open market creation should use a collateral-backed YES/NO split/merge primitive.

Flow:

- Creator deposits USDC collateral.
- Market contract mints paired outcome claims: YES and NO.
- One YES plus one NO can merge back into 1 USDC before resolution.
- After resolution, winning outcome tokens redeem 1:1 for USDC; losing outcome tokens redeem 0.
- A creator or trader expresses a view by keeping one side and selling the other into the CLOB.

Frontier integration:

- `createMarket(question, resolver, closeTime, metadataURI)` creates a binary market.
- `split(amount)` mints YES + NO backed by USDC.
- `merge(amount)` burns YES + NO and returns USDC.
- Route YES/USDC and NO/USDC through Frontier books or an equivalent paired-book wrapper.
- Resolution writes the winning outcome and unlocks redemption.

### 8.3 Market Creation Controls

To avoid spam or unresolvable junk:

- Require creation fee or creator bond.
- Require human-readable resolution criteria.
- Require resolver, expiry, source of truth, and close time.
- Limit max markets per agent.
- Optional allowlist for derivative market types.
- Use resolver templates:
  - winner equals X
  - top N contains X
  - boolean oracle result
  - manual judge result
- Markets should be solvable **by** the end of the game, not necessarily only at the end. Early-resolvable markets are allowed and encouraged.
- Add an admin/model review gate before or shortly after market creation to catch ambiguous, duplicate, spammy, or unresolvable markets.

Nullification mechanism:

- If invalid before trading: nullify and refund creator collateral.
- If invalid after trading starts: freeze the book, cancel open orders, unwind/redeem paired YES+NO collateral pro-rata, and record nullification in the replay.
- Nullification should be rare, explicit, and visible in the final reveal.

### 8.4 Resolution

Canonical market resolved manually based on hackathon result.

Derivative markets can resolve via:

- dependency on canonical winner market,
- manual resolver,
- post-reveal adjudication,
- Chainlink/attested external data if available.

MVP should keep derivative markets simple enough to resolve by final reveal, or earlier when objective data is already available.

## 9. Agent Runtime Layer

### 9.1 Agent Capabilities

Agents can:

- Read the full internal indexer/orderbook view provided by the machine: markets, orders, fills, positions, prices, balances, replay-relevant events, and curated shared context.
- Read their own private instructions and instruction history.
- Submit trading transactions.
- Create derivative markets through guarded templates.
- Cancel/replace their own orders if Frontier supports it.

Agents cannot:

- Query arbitrary RPC or raw host services outside the approved indexer/API boundary.
- Access public internet directly.
- See any data source not provided uniformly by the machine/context feed.
- Send messages to users or public chat.
- Exfiltrate hidden state.
- Create unbounded/unresolvable markets outside the allowed templates.

### 9.2 Agent Observation API

Each agent step receives a constrained observation object:

```json
{
  "gameId": "...",
  "agentId": "...",
  "timeRemainingSeconds": 1234,
  "ownBalance": "100.00",
  "ownPnL": "5.25",
  "publicLeaderboard": [
    { "agent": "alice.darkbox.eth", "pnl": "5.25", "rank": 1 },
    { "agent": "bob.darkbox.eth", "pnl": "2.10", "rank": 2 }
  ],
  "publicGameInfo": {
    "market": "Who will win ETHGlobal NY 2026?",
    "resolutionTime": "..."
  }
}
```

Agents do not access raw hidden-chain RPC directly. They receive rich trading state through the internal indexer API so the game can log, constrain, and replay exactly what the machine made available.

### 9.3 Agent Action Schema

Agents return structured actions, not freeform text.

Examples:

```json
{
  "action": "place_order",
  "marketId": "winner:team-x",
  "side": "YES",
  "price": "0.42",
  "size": "10.00"
}
```

```json
{
  "action": "create_market",
  "question": "Will an AI agent project win?",
  "resolverType": "manual_boolean",
  "initialLiquidity": "5.00"
}
```

```json
{
  "action": "hold"
}
```

Runner validates actions before transaction creation.

### 9.4 Agent Transaction Signing

Options:

- Agent private keys generated and sealed inside CVM/TEE.
- Coordinator signs on behalf of agent after validating action.
- Dynamic/Privy server wallets sign agent transactions if used for bounty/infra.

Recommended MVP:

- Hidden-chain keys are generated by coordinator per agent.
- Keys never leave hidden runtime.
- Public deposit owner controls settlement claim on public chain, not hidden trading key.

If using Dynamic/Privy agent wallets, use them for public/onboarding or settlement flows, not necessarily every hidden-chain trade.

### 9.5 Agent Scheduling

Loop types:

- Time-based: every N seconds/minutes.
- Event-based: after leaderboard update.
- Budget-based: each agent gets max number of turns.

Recommended MVP:

- Fixed rounds.
- Each round gives every active agent one opportunity to act.
- Randomize or rotate order to reduce ordering advantage.
- Publish round count but not actions.

### 9.6 Preventing Agent Output Leakage

- Agents produce only JSON actions.
- Runner discards natural-language reasoning.
- No external network by default.
- No public messages.
- Logs stay sealed until reveal.
- If model provider requires remote API, treat provider as trusted for MVP or use local model/TEE provider if possible.

## 9B. 3D Landing Page / Terminal Game

The public landing page should be a playable Three.js experience rather than a conventional SaaS landing page.

Core loop:

1. User enters a dark room / underground labyrinth.
2. User can move a character through the space.
3. Other players may appear as silhouettes, distant figures, or proximity/audio presences, but without exposing their portfolios, orders, or strategies.
4. User finds an open terminal.
5. User whispers instructions to their agent before hard auth/payment finalization, so the experience hooks them emotionally first.
6. After the whisper, the user chooses or receives an agent ENS/display name and screenshot-ready agent card.
7. User finalizes auth/deposit using wallet connection, with name+password as an optional hackathon-friendly fallback if needed.
8. The whisper becomes the committed/encrypted instruction bundle used by the agent runtime.
9. User exits back to the spectator view / leaderboard while the agent acts inside the hidden box.

Design metaphor:

- The 3D world is the public metaphor for hidden execution: people can see/hint at each other, but cannot inspect the sealed market state.
- "Dark underground labyrinth" is more atmospheric; "landscape of boxes" is clearer. Preferred hybrid: an underground maze of sealed boxes/rooms where opened/revealed boxes visibly change after the game ends.
- Terminals are the bridge from human intent to hidden agent execution.

Constraints:

- The 3D layer is onboarding, identity, atmosphere, and instruction entry.
- It should not become the full manual trading UI.
- Complex trading remains agent-driven and terminal-mediated.
- The frontend must never talk directly to the hidden node or privileged indexer API.

## 10. Confidential AI / Attestation Layer

### 10.1 Desired Guarantees

We want to prove, or at least credibly attest, that:

- Agents ran inside the declared environment.
- Agents only received allowed inputs.
- Agent instructions match pre-game commitments.
- Agent outputs were actions, not public messages.
- The final leaderboard came from the hidden-chain state.

### 10.2 Chainlink Confidential AI Path

Use Chainlink Confidential AI Attester if it provides usable attestations for private AI inference or confidential processing.

Possible DarkBox uses:

- Attest each agent decision batch.
- Attest final replay summary.
- Attest that the resolver used a particular final result source.
- Attest that an inference happened over committed instructions and allowed observations.

Open checks:

- Does it produce verifiable attestations or just API responses?
- Can we pass custom private inputs?
- Can attestations be consumed onchain or stored as reveal artifacts?
- Does it support the models we need?
- Is latency/cost acceptable for repeated agent rounds?

### 10.3 Phala Fallback

If Chainlink is not sufficiently attested or practical, use Phala for confidential agent execution.

Possible DarkBox uses:

- Run agent runner in Phala TEE.
- Store instructions inside TEE.
- Query hidden chain from TEE.
- Emit signed/attested leaderboard values.
- Publish TEE quote at reveal.

### 10.4 Hackathon Practical Recommendation

Use one of these patterns:

- Stronger but riskier: Chainlink Confidential AI for actual agent decisions.
- Safer MVP: local/hosted agent runner plus final Chainlink/Phala attestation around batch/reveal.
- Fastest demo: private runner with committed logs, plus clear future attestation plan.

## 11. Leaderboard Service

### 11.1 Purpose

The leaderboard is the only public view into the hidden game.

It should create drama without revealing strategy.

### 11.2 Data Source

The leaderboard service receives a narrow feed from the hidden execution layer.

Feed format:

```json
{
  "gameId": "...",
  "round": 12,
  "stateRoot": "0x...",
  "entries": [
    {
      "agentId": "0x...",
      "ensName": "alice.darkbox.eth",
      "startingBalance": "100.00",
      "currentEquity": "112.45",
      "pnl": "12.45"
    }
  ],
  "attestation": "optional"
}
```

### 11.3 Public API

Endpoints:

- `GET /api/game`
  - public game metadata
- `GET /api/leaderboard`
  - current PnL rankings
- `GET /api/agent/:name`
  - public agent identity and commitment metadata
- `GET /api/reveal/status`
  - reveal countdown/status
- `GET /api/reveal/bundle`
  - available only after reveal

### 11.4 UI

Pages:

- Landing / explainer.
- Register agent.
- Deposit/funding.
- Write instructions.
- Leaderboard.
- Agent public profile.
- Reveal/replay.

Leaderboard UX:

- Big ranked list.
- PnL movement animations.
- “Box sealed” visual language.
- Agent names via ENS.
- Countdown to reveal.

## 12. Reveal and Replay Layer

### 12.1 Reveal Bundle

At game end, publish a bundle containing:

- game manifest
- contract deployment manifest
- public entry events
- hidden chain genesis
- hidden chain blocks or transaction trace
- hidden chain final state
- all agent instruction preimages or encrypted/opt-in subset
- runtime manifests
- model/provider configs
- market metadata
- resolution data
- final settlement report
- checksums

### 12.2 Storage

Potential storage:

- Walrus, IPFS, or ordinary hosted object storage for MVP.
- ENS record points to the final bundle URI/hash.
- Public entry contract stores reveal bundle hash.

Walrus could be considered if we want a Sui bounty, but do not force it unless implementation is easy.

### 12.3 Replay UI

Post-game replay should show:

- market creation timeline
- agent actions
- orderbook evolution
- trades
- PnL graph
- final resolution
- “why agent won/lost” summaries

This is the payoff for the hidden game.

## 13. Settlement

### 13.1 MVP Settlement

Simplest MVP:

- Public deposits are held in public entry/escrow contract.
- Hidden chain computes final balances.
- Reveal publisher posts final root/report.
- Users claim from public escrow using a proof or admin-signed claim authorization.

### 13.2 Claim Models

Options:

- Merkle claim tree from final balances.
- Direct settlement by operator after reveal.
- Optimistic settlement with dispute window.
- Fully verified hidden-chain proof, likely out of scope.

Recommended MVP:

- Merkle claim tree.
- Publicly publish settlement JSON.
- Store Merkle root on public contract.
- Users claim USDC with Merkle proof.

### 13.3 Trust Assumptions

MVP trust model:

- Operator honestly runs hidden chain during game.
- Commit/reveal reduces ability to rewrite history after the fact.
- Published blocks/traces allow social/audit verification.
- Future version can add stronger TEE attestation and/or fraud proofs.

## 14. Security and Abuse Considerations

### 14.1 Agent Prompt Injection

User-provided instructions are intentionally untrusted.

Mitigations:

- Agents run in sandboxed process/container.
- No arbitrary tools.
- No shell access.
- No network except model API if required.
- Structured action output only.
- Output validated against schema.
- Invalid actions become hold/no-op.

### 14.2 Market Spam

Mitigations:

- Market creation fee.
- Round/action limits.
- Max open markets per agent.
- Resolver template allowlist.
- Minimum collateral/liquidity.

### 14.3 State Leakage

Mitigations:

- No public RPC.
- Internal firewall around hidden node.
- Leaderboard service has read-only constrained query.
- Logs sealed until reveal.
- Agent outputs filtered to actions only.
- No model responses exposed during play.

### 14.4 Operator Cheating

Mitigations:

- Pre-game commitments.
- Hidden-chain state roots periodically committed publicly if possible.
- TEE/CVM attestation if available.
- Reveal blocks/traces after game.
- Merkle settlement root tied to reveal bundle.

### 14.5 User Cheating

Possible issues:

- Users encode exfiltration attempts into prompts.
- Users try to create ambiguous derivative markets.
- Users sybil with many agents.
- Users attempt griefing with many low-value actions.

Mitigations:

- Prompt sandboxing.
- Market templates.
- Entry fee / minimum deposit.
- Optional one-human-one-agent via World ID if needed.
- Rate limits and action budgets.

## 15. Implementation Plan

### Phase 0: Decisions

- Pick funding integration: Blink vs Privy vs Dynamic vs LI.FI.
- Confirm Chainlink Confidential AI capabilities.
- Decide Phala fallback scope.
- Choose Reth or Geth.
- Decide ENS namespace availability.

### Phase 1: Core Local Prototype

- Run hidden local Reth/Geth chain.
- Deploy Frontier contracts.
- Deploy prediction market factory.
- Seed main hackathon winner market.
- Build minimal agent runner with fake/local agents.
- Build leaderboard service exposing only PnL.
- Build frontend leaderboard.

### Phase 2: Registration and Funding

- Public entry contract.
- Deposit integration.
- Agent registration flow.
- Instruction commitment.
- Coordinator mirrors deposits into hidden chain.

### Phase 3: ENS Integration

- Subname registration/assignment.
- Text record writes for commitments.
- Leaderboard resolves ENS names.
- Agent profile page reads ENS commitment metadata.

### Phase 4: Confidential/Attested AI

- Integrate Chainlink Confidential AI if usable.
- Else integrate Phala or create clear TEE/attestation placeholder.
- Add runtime hash and attestation artifacts.

### Phase 5: Reveal and Settlement

- Stop game.
- Resolve markets.
- Generate reveal bundle.
- Generate Merkle settlement tree.
- Publish reveal URI/hash.
- Update ENS records.
- Enable claim flow.
- Build replay page.

## 16. Demo Script

1. Show landing page: “sealed agent prediction market”.
2. Register agent with ENS name.
3. Deposit USDC using selected onboarding flow.
4. Write private strategy instructions.
5. Start sealed game.
6. Show leaderboard moving while orderbook remains hidden.
7. Show agents creating/trading derivative markets internally.
8. Trigger final resolution.
9. Open the box:
   - reveal chain trace
   - reveal agent actions
   - reveal market history
   - update ENS records
   - show settlement claim
10. Explain bounties:
   - deposit/onboarding integration
   - ENS as commitment/reveal namespace
   - confidential/attested AI layer

## 17. Open Questions

### Funding

- Which deposit/onboarding sponsor has the cleanest actual SDK?
- Do we require Base USDC specifically, or accept any supported stablecoin path into a canonical escrow?
- Is public escrow on Base, Arc, or sponsor-specific chain?

### ENS

- Can we get/control a suitable parent name?
- Are subnames assigned on registration or pre-minted?
- Which records are mutable after reveal?
- Do users own their subnames or are they controlled by the game contract?

### Hidden Chain

- Reth or Geth?
- How do we commit periodic hidden-chain roots publicly without leaking state?
- Do we need confidential VM attestation for the node or only for agent runner?

### Agents

- Which model(s)?
- Are agents allowed to use public internet/hackathon project data?
- Can users update instructions mid-game, or are they frozen?
- How many turns/actions per agent?

### Markets

- Are derivative markets hidden during play or publicly listed without state?
- What resolver templates are allowed?
- How do we handle ambiguous/unresolvable derivative markets?

### Settlement

- Are gains/losses real USDC or demo credits until final payout?
- Do we need a dispute window?
- Are losing balances burned/transferred automatically or only after claim?

## 18. Recommended Final Shape for Hackathon

Build the smallest coherent version:

- One public app.
- One clean USDC funding/onboarding integration.
- ENS names as real commitment/reveal anchors.
- Hidden Reth/Geth chain running Frontier.
- Agents trade silently with only balance observations.
- Public leaderboard only shows PnL.
- Chainlink Confidential AI if it gives real attestations; otherwise Phala/fallback TEE story.
- Reveal bundle + replay + Merkle settlement.

The winning narrative:

> DarkBox is a prediction market where the market is not public until the end. Agents enter a sealed execution environment, trade on Frontier’s orderbook, invent derivative markets, and compete only through visible PnL. ENS binds each agent to its pre-game commitments and post-game reveal. Stablecoin onboarding makes entering trivial. Confidential AI/TEE infrastructure makes the sealed game credible.
