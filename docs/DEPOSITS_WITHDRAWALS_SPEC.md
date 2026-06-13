# Deposits + Withdrawals Specification

## 1. Decision

DarkBox uses a public USDC escrow contract as the source of truth for player funding and final payout.

For the hackathon MVP:

- Canonical asset: USDC.
- Canonical escrow chain: Base, unless the chosen sponsor integration requires a different settlement chain.
- UX adapter: one sponsor/onboarding path only.
- Reliability fallback: direct Base USDC deposit into the escrow contract.
- Hidden-chain balance: synthetic game credit minted 1:1 from confirmed public escrow deposits.
- Withdrawals: disabled during live play; unlocked only through pre-game refunds or post-reveal settlement claims.

The bridge service is not a general bridge. It is a coordinator that watches public funding, credits the hidden chain, and later produces/verifies settlement artifacts.

## 2. Goals

- Make entry feel simple: fund an agent, write instructions, enter the box.
- Keep real USDC custody outside the hidden chain.
- Never expose hidden orderbook/trade/position state through deposit or withdrawal flows.
- Make every hidden-chain credit traceable to a public funding event.
- Make final payout auditable from the reveal bundle.
- Keep the stack Docker/local-first so the same services can run locally and inside the CVM deployment.

## 3. Non-Goals

- Permissionless cross-chain bridge custody.
- Live mid-game withdrawals.
- Revealing agent positions to justify partial withdrawals.
- Supporting many onboarding providers in the MVP.
- Letting the frontend talk directly to hidden node or privileged indexer APIs.

## 4. Actors

- User: funds an agent and may claim settlement after reveal.
- Frontend: public app; talks only to public bridge/indexer APIs.
- Escrow contract: public USDC custody, registration, commitments, refund/claim gates.
- Bridge service: watches escrow/provider events, writes hidden-chain credit transactions, stores idempotency state, generates settlement claims.
- Hidden chain: receives synthetic credit transactions and runs Frontier markets.
- Indexer: computes internal balances/PnL and exports final settlement data after reveal.
- Reveal service: publishes replay bundle and settlement root.
- ENS service: writes commitment/reveal metadata records.

## 5. Asset Model

### 5.1 Public Escrow Balance

Real USDC stays in the public escrow contract.

Escrow tracks:

- game id
- agent id
- depositor wallet
- total deposited
- refunded amount
- final claimed amount
- registration/freeze/finalization status

### 5.2 Hidden-Chain Credit

The hidden chain receives synthetic credits, not bridged USDC.

Rules:

- One public USDC unit equals one hidden credit unit.
- Credits are minted only by the coordinator key.
- Every credit transaction references a public deposit event id.
- Duplicate deposit events must not create duplicate credits.
- Hidden credits are game accounting balances, not withdrawable tokens during play.

### 5.3 Final Settlement

After reveal, the final hidden-chain state produces a public settlement root.

Settlement maps each agent to:

- final claimable USDC amount
- total deposits
- realized PnL
- fees, if any
- settlement proof path

The public escrow contract pays claims against this root.

## 6. Deposit Lifecycle

### 6.1 States

```text
created -> awaiting_funds -> funded -> credited_hidden -> active -> finalized -> claimed
                         \-> refund_requested -> refunded
                         \-> failed
```

### 6.2 Happy Path

1. User creates a registration draft in the frontend.
2. Frontend requests a funding intent from `darkbox-bridge`.
3. Bridge returns one funding path:
   - sponsor/onboarding checkout, or
   - direct Base USDC escrow deposit calldata.
4. User funds the intent.
5. Escrow emits `AgentFunded` or bridge receives provider confirmation.
6. Bridge waits for the required confirmation threshold.
7. Bridge records the event in its local DB with an idempotency key.
8. Bridge submits `creditAgent(agentId, amount, depositEventId)` to the hidden chain.
9. Hidden chain emits `AgentCredited`.
10. Indexer sees the hidden credit and updates the agent balance.
11. Public API shows only registration/funding status and aggregate leaderboard-safe balance data.

### 6.3 Confirmation Policy

MVP defaults:

- Direct Base deposit: wait for 3 confirmations.
- Provider flow: wait for provider terminal success plus any on-chain confirmation needed by the adapter.
- Never credit hidden chain on mempool-only events.

### 6.4 Deposit Idempotency

Bridge idempotency key:

```text
chainId:escrowAddress:txHash:logIndex:agentId:amount
```

Rules:

- If the same key is seen again, do not submit another hidden-chain credit.
- If hidden-chain submission succeeds but bridge crashes before marking success, recover by searching for `AgentCredited(depositEventId)` before retrying.
- If provider webhooks duplicate, normalize them to the same escrow event or provider event id before processing.

## 7. Registration Commitments

Funding and registration can be two transactions or one composed flow.

Required commitment fields:

- `gameId`
- `agentId`
- `depositor`
- `ensName` or `ensNode`
- `instructionHash`
- `runtimeHash`
- `revealSaltHash`
- `depositAmount`
- `createdAt`

Registration is frozen at game start. After freeze:

- no new agents
- no instruction updates unless explicitly included in game rules
- no refunds except admin/emergency cancellation
- deposits that arrive late are refundable, not credited

## 8. Withdrawal and Refund Rules

### 8.1 Before Registration Freeze

Users may request a refund if:

- the game has not frozen registration
- the deposit has not been credited to active play, or the coordinator can safely reverse/unwind pre-start credit
- the agent has not entered live trading

MVP simplification:

- allow refunds before `freezeRegistration`
- disallow refunds after freeze

### 8.2 During Game

Withdrawals are disabled.

Reason:

- A live withdrawal would reveal balance/position pressure.
- It would require hidden state proofs before reveal.
- It creates market manipulation and insolvency edge cases.

The UI should say: “Funds are locked during the match. Claim opens after reveal.”

### 8.3 After Reveal

Claims open when:

1. trading is stopped
2. markets are resolved
3. reveal bundle is published
4. settlement root is published to escrow
5. optional dispute/challenge window expires, if enabled

MVP can set dispute window to zero for demo, but the spec should keep the field.

Claim flow:

1. User opens claim page.
2. Frontend fetches public settlement proof.
3. User calls `claim(agentId, amount, proof)` on escrow.
4. Escrow verifies the Merkle proof against `settlementRoot`.
5. Escrow transfers USDC.
6. Escrow marks the agent claim as spent.

### 8.4 Failed or Cancelled Game

If game is cancelled before finalization:

- admin publishes `cancelGame(gameId)`
- users can withdraw original deposits minus explicitly documented non-refundable fees, ideally zero for MVP
- no hidden-chain PnL is used

## 9. Escrow Contract Interface

Candidate Solidity interface:

```solidity
interface IDarkBoxEscrow {
    event AgentRegistered(
        bytes32 indexed gameId,
        bytes32 indexed agentId,
        address indexed depositor,
        string ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    );

    event AgentFunded(
        bytes32 indexed gameId,
        bytes32 indexed agentId,
        address indexed depositor,
        uint256 amount,
        bytes32 fundingRef
    );

    event RegistrationFrozen(bytes32 indexed gameId, uint64 frozenAt);
    event FinalRootPublished(bytes32 indexed gameId, bytes32 hiddenChainRoot, bytes32 revealBundleHash, bytes32 settlementRoot);
    event Refunded(bytes32 indexed gameId, bytes32 indexed agentId, address indexed recipient, uint256 amount);
    event Claimed(bytes32 indexed gameId, bytes32 indexed agentId, address indexed recipient, uint256 amount);

    function registerAgent(
        bytes32 gameId,
        bytes32 agentId,
        string calldata ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    ) external;

    function depositForAgent(bytes32 gameId, bytes32 agentId, uint256 amount, bytes32 fundingRef) external;

    function registerAndDeposit(
        bytes32 gameId,
        bytes32 agentId,
        string calldata ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash,
        uint256 amount,
        bytes32 fundingRef
    ) external;

    function freezeRegistration(bytes32 gameId) external;

    function publishFinalRoot(
        bytes32 gameId,
        bytes32 hiddenChainRoot,
        bytes32 revealBundleHash,
        bytes32 settlementRoot
    ) external;

    function refund(bytes32 gameId, bytes32 agentId) external;

    function claim(
        bytes32 gameId,
        bytes32 agentId,
        address recipient,
        uint256 amount,
        bytes32[] calldata proof
    ) external;
}
```

## 10. Bridge Service API

Public endpoints exposed by `darkbox-bridge`:

- `POST /api/funding-intents`
  - creates a deposit intent for an agent registration draft
  - returns checkout URL or direct deposit calldata
- `GET /api/funding-intents/:id`
  - returns status: `created`, `awaiting_funds`, `funded`, `credited_hidden`, `failed`, `refundable`
- `GET /api/claims/:agentId`
  - after reveal, returns claim amount and proof if available

Internal endpoints, not public:

- `POST /internal/deposits/reconcile`
- `POST /internal/credits/retry`
- `POST /internal/settlement/build`
- `GET /internal/settlement/export`

The public frontend must never receive internal deposit reconciliation data that reveals hidden trades, positions, or per-market PnL before reveal.

## 11. Bridge Worker Responsibilities

Workers:

- public chain watcher
- provider webhook normalizer, if sponsor UX is used
- hidden-chain credit submitter
- reconciliation worker
- settlement artifact builder
- claim proof server

Required persistence:

- funding intents
- observed escrow events
- provider events
- hidden credit transaction hashes
- retry counts
- final settlement proofs

Local-first storage can be Postgres or SQLite for MVP. If using SQLite locally, keep the schema compatible with Postgres for CVM deployment.

## 12. Docker / CVM Deployment

`darkbox-bridge` runs as its own container.

Required networks:

- `public_net`: frontend/API ingress for public endpoints
- `cvm_net`: internal calls to indexer/reveal/hidden node if colocated
- `egress_net`: public chain RPC, onboarding provider API, Base RPC

Required secrets:

- public chain RPC URL
- escrow admin/finalizer key or signer service credentials
- hidden-chain coordinator key
- provider API keys/webhook secret, if used
- database credentials

Required environment variables:

```text
GAME_ID=
BASE_CHAIN_ID=8453
USDC_ADDRESS=
ESCROW_ADDRESS=
PUBLIC_RPC_URL=
HIDDEN_RPC_URL=
BRIDGE_COORDINATOR_ADDRESS=
CONFIRMATIONS_REQUIRED=3
FUNDING_PROVIDER=direct|blink|privy|dynamic|lifi
DATABASE_URL=
```

## 13. Security Invariants

- Public escrow must never depend on unrevealed hidden state before final root publication.
- Hidden-chain credits must be idempotent.
- Funding provider webhooks are advisory until reconciled against canonical escrow/provider state.
- The public bridge API must not expose hidden balances beyond the allowed user-specific status and public leaderboard aggregates.
- Claims must be single-use.
- Settlement root publication must be gated to finalizer/admin multisig for MVP.
- Coordinator keys must be injected as Docker secrets or CVM-sealed secrets, never baked into images.
- Late deposits after freeze must be refundable, not silently credited.

## 14. MVP Implementation Plan

1. Implement escrow contract with `registerAndDeposit`, freeze, cancel/refund, final root publish, and Merkle claim.
2. Implement `darkbox-bridge` direct Base USDC watcher.
3. Add funding intent API that returns direct deposit calldata.
4. Add idempotent hidden-chain credit submitter.
5. Add frontend funding status page.
6. Add settlement artifact format to reveal service.
7. Add claim proof endpoint and claim page.
8. Only then add one sponsor UX adapter if it is faster/better for the demo.

## 15. Demo Script

- User connects wallet.
- User names agent and writes instructions.
- User deposits USDC.
- UI shows “funded, waiting for box credit”.
- Bridge credits hidden chain.
- UI shows “agent entered the box”.
- During play, user sees only leaderboard-safe info.
- At reveal, user sees replay + final PnL.
- User claims final USDC payout from escrow.
