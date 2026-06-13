# Deposits + Withdrawals Specification

## 1. Decision

DarkBox uses a public bridge/escrow contract for USDC and shadow USDC inside the local shadow EVM for in-game accounting.

Users may deposit into or withdraw from their agent at any time, with one constraint: withdrawals can only use withdrawable available balance. Users cannot force liquidation of open orders or positions.

For the hackathon MVP:

- Canonical public asset: USDC only. Other collateral assets are out of scope.
- Canonical escrow chains: Base and Arc for MVP. Both feed one canonical shadow USDC balance.
- Public contract: accepts direct USDC ERC-20 transfers and explicit USDC deposit function calls only.
- Shadow EVM: mints/burns shadow USDC for the user's mapped shadow account. It should not model arbitrary collateral assets.
- Disposable invite links/codes: valid claims mint a $5 promo shadow USDC starter credit so users can play without depositing.
- Ownership mapping: every shadow account maps to an onchain owner wallet.
- Withdrawals: user signs a withdrawal command; the system forces the agent/shadow account to burn or transfer shadow funds in the shadow EVM; a signing service authorizes public escrow withdrawal.
- Emergency withdrawal: retained through multisig/admin transaction path.

There are no Merkle claims in the normal withdrawal path. Withdrawals are online, signing-service authorized bridge exits against available shadow balance.

## 2. Goals

- Let users top up or withdraw available agent funds any time.
- Keep real assets custodied in the public bridge/escrow contract.
- Keep strategy risk intact: users can withdraw idle balance but cannot liquidate active positions through the bridge.
- Make every real-deposit shadow mint traceable to a public deposit operation.
- Make every promo-credit shadow mint traceable to an admin-created invite claim.
- Make every public withdrawal traceable to a user-signed command and a shadow-EVM burn/transfer.
- Keep the public frontend away from hidden orderbook/trade/position APIs.
- Keep the stack Docker/local-first so the same services can run locally and inside the CVM deployment.

## 3. Non-Goals

- General-purpose bridge custody across arbitrary chains beyond the configured Base/Arc MVP set.
- Forced liquidation of positions to satisfy withdrawals.
- Public exposure of hidden orderbooks, trades, positions, or per-market PnL.
- Supporting many onboarding providers in the MVP.
- Letting the frontend talk directly to the hidden node or privileged indexer APIs.
- Merkle-claim settlement as the standard withdrawal mechanism.

## 4. Actors

- User: owns an onchain wallet, maps to a shadow account, deposits/withdraws available funds, or joins through a disposable invite bonus without depositing.
- Agent: trades inside the shadow EVM using the user's shadow balance and instructions.
- Frontend: public app; talks only to public bridge/indexer APIs.
- Public bridge contract: custodies real USDC, records deposits, verifies signing-service withdrawals, supports emergency multisig exits.
- Bridge service: detects public deposits, mints shadow funds, processes user withdrawal commands, asks signing service for exit signatures.
- Signing service: signs withdrawal authorizations after shadow burn/transfer is confirmed.
- Shadow EVM: holds shadow accounts, owner mapping, shadow assets, Frontier markets, and bridge-controller contracts.
- Indexer: computes internal balances, available withdrawable balance, PnL, positions, and public-safe leaderboard data.
- Multisig/admin: emergency withdrawal and recovery authority.

## 5. Account and Asset Model

### 5.1 Onchain Owner to Shadow Account Mapping

The shadow EVM must maintain a canonical mapping:

```text
onchain owner wallet -> shadow account
shadow account -> onchain owner wallet
```

Rules:

- A user controls withdrawals by signing with the onchain owner wallet.
- Deposits are credited to the mapped shadow account.
- If no mapping exists, the bridge creates or registers one before minting shadow funds.
- Agent trading permissions operate on the shadow account, but ownership remains anchored to the onchain wallet.
- The mapping is stored inside the shadow EVM and mirrored by the bridge database for indexing/recovery.

### 5.2 Public Escrow Balance

Real USDC stays in public bridge/escrow contracts on configured source/destination chains.

Escrow tracks:

- onchain owner
- optional beneficiary owner
- total deposited
- total withdrawn
- chain id and bridge address
- used withdrawal nonces
- emergency status

### 5.3 Shadow Asset Balance

The shadow EVM mints local shadow USDC corresponding to public deposits.

Rules:

- Public USDC deposit mints real-deposit shadow USDC.
- Valid disposable invite claim mints $5 promo shadow USDC.
- Minting is performed only by the shadow bridge controller/coordinator.
- Every mint references a public deposit operation id.
- Duplicate public operations must not create duplicate shadow mints.

### 5.4 Withdrawable Available Balance

Withdrawable balance is not total portfolio value.

Withdrawable balance equals idle/free balance that is not:

- locked in open orders
- posted as collateral or margin
- reserved for pending internal transfers
- required by unresolved market constraints
- already committed to a pending withdrawal command
- any balance in an account that claimed the $5 invite bonus before the Sunday 17:00 event-local unlock

Users may withdraw only this available amount. If they want more, the agent must voluntarily cancel orders, close positions, or wait for fills/resolution according to normal market rules.

## 6. Deposit Lifecycle

### 6.1 Supported Deposit Paths

DarkBox supports both passive sends and explicit function calls.

1. Direct ERC-20 transfer:
   - user transfers USDC to the public bridge contract
   - offchain system detects the USDC `Transfer(from, bridge, amount)` event
   - beneficiary defaults to `from`, unless a prior deposit intent maps the transfer to another beneficiary

2. Explicit deposit function:
   - user approves USDC
   - user calls `deposit(amount, beneficiary)`
   - useful for normal app UX and composed flows such as LI.FI

3. Cross-chain/onboarding adapter:
   - provider flow ultimately sends USDC to the bridge or calls `deposit(...)`
   - offchain normalizer maps the operation to the beneficiary owner

### 6.2 Deposit State Machine

```text
observed_public_deposit -> confirmed_public_deposit -> mapping_resolved -> shadow_mint_submitted -> shadow_minted
                                                        \-> failed_needs_reconcile
```

Deposits are allowed any time unless the game or bridge is paused.

### 6.3 Deposit Happy Path

1. User sends USDC to bridge or calls `deposit(amount, beneficiary)`.
2. Bridge watcher detects the operation.
3. Bridge waits for the required confirmation threshold.
4. Bridge resolves beneficiary owner and shadow account mapping.
5. If needed, bridge creates/updates the shadow account mapping in the shadow EVM.
6. Bridge submits `mintShadow(shadowAccount, amount, depositOpId)` to the shadow bridge controller.
7. Shadow EVM emits `ShadowMinted`.
8. Indexer sees the mint and updates available balance.
9. UI shows the deposit as credited.

### 6.4 Deposit Idempotency

Deposit operation id:

```text
sourceChainId:bridgeAddress:usdc:txHash:logIndex:from:beneficiary:amount
```

Rules:

- If the same operation id is seen again, do not mint again.
- If the shadow mint succeeds but bridge crashes before marking success, recover by searching shadow EVM for `ShadowMinted(depositOpId)` before retrying.
- Direct USDC transfers without explicit beneficiary credit the sender by default.
- Deposit intents can override beneficiary only when the observed transfer matches the intent constraints.

### 6.5 Multichain Deposit Normalization

DarkBox may deploy one public bridge contract per configured escrow chain, initially Base and Arc. Deposits on either chain mint the same canonical shadow USDC. The shadow EVM must not track separate Base-USDC and Arc-USDC user balances.

Rules:

- Each bridge watcher is configured with `(sourceChainId, bridgeAddress, usdcAddress, confirmationsRequired)`.
- Deposit operation ids include source chain and bridge address, so identical-looking transfers on different chains cannot collide.
- Confirmed deposits from Base and Arc both call the same shadow mint path.
- Public escrow solvency is tracked per chain, but user game balance is global.
- Unsupported chains and unsupported tokens do not mint shadow balance.

## 7. Disposable Invite Signup Bonus Lifecycle

Disposable invites are a core MVP onboarding path, not a stretch goal. They let a hackathon participant start playing without first sending USDC.

### 7.1 Invite Rules

- Admin or operator creates an invite code/link with a hashed secret/start parameter.
- Default bonus amount is 5 USDC-equivalent shadow credit.
- Default usage is one claim per invite link. Campaign links may allow bounded multi-use only with explicit admin config.
- Invite links can expire or be revoked.
- A wallet/Telegram identity can claim at most one signup bonus per game unless admin overrides it.
- Claims require registration/mapping to an owner wallet and shadow account before minting.

### 7.2 Promo Credit Mint

Invite operation id:

```text
gameId:inviteId:claimantOwner:shadowAccount:bonusAmount
```

Rules:

- Valid invite claim mints promo shadow USDC to the mapped shadow account.
- Promo mints are emitted/indexed separately from real USDC deposit mints.
- Accounts that claim the $5 invite bonus cannot withdraw anything until Sunday 17:00 event-local time. They can trade normally before the unlock.
- After the unlock, withdrawals follow normal withdrawable-balance rules.
- Every promo mint must appear in reveal accounting so observers can distinguish real deposits from signup bonuses.

## 8. Withdrawal Lifecycle

### 8.1 Withdrawal State Machine

```text
requested -> user_signed -> shadow_burn_submitted -> shadow_burned -> service_signed -> submitted_public_withdrawal -> withdrawn
          \-> rejected_insufficient_available
          \-> failed_needs_reconcile
```

### 8.2 User-Signed Withdrawal Command

When a user wants to withdraw:

1. User connects their owner wallet.
2. UI fetches withdrawable available balance from the public-safe bridge/indexer API.
3. User chooses amount, recipient, and shadow account.
4. User signs an EIP-712 withdrawal command.
5. Bridge treats this signature as a command to the user's agent/shadow account.

The user signature authorizes the system to force a shadow-EVM burn/transfer of idle shadow funds. It does not authorize liquidation of positions.

Suggested EIP-712 fields:

```text
WithdrawCommand {
  gameId
  owner
  shadowAccount
  amount
  recipient
  nonce
  deadline
  bridgeContract
  shadowChainId
}
```

### 8.3 Forced Shadow Burn / Transfer

After validating the user signature, the bridge submits a shadow-EVM transaction that forces one of:

- burn shadow USDC from the user's shadow account, or
- transfer shadow USDC from the user's shadow account to a bridge sink account

Rules:

- The shadow bridge controller checks available withdrawable balance.
- It must not cancel orders or liquidate positions.
- It reserves the amount immediately to prevent double-withdrawal.
- It emits `ShadowWithdrawalLocked` or `ShadowBurned` with the withdrawal id.

### 8.4 Signing-Service Public Withdrawal

Once the shadow burn/transfer is confirmed:

1. Bridge asks the signing service for a public withdrawal authorization.
2. Signing service verifies:
   - user EIP-712 signature
   - owner-to-shadow mapping
   - shadow burn/transfer event
   - nonce unused
   - amount/recipient match
3. Signing service returns a signature over the public withdrawal payload.
4. UI receives the signing-service signature.
5. User submits `withdraw(...)` to the public bridge contract.
6. Public bridge verifies signer authorization, marks nonce used, transfers USDC.

This makes withdrawal user-initiated while preserving the invariant that public escrow only releases USDC after the corresponding shadow funds are removed from circulation.

### 8.5 Multichain Withdrawal and Liquidity Routing

Users may request withdrawal to any configured payout chain, initially Base or Arc. The game balance remains a single shadow USDC balance; it is not split by deposit chain.

Withdrawal command additions:

```text
WithdrawCommand {
  ...
  destinationChainId
  destinationBridge
  recipient
}
```

Rules:

- The user first signs a withdrawal command for amount, recipient, destination chain, and destination bridge.
- The bridge service validates the command and burns/reserves shadow USDC before any public-chain payout signature is issued.
- After the shadow burn is confirmed, the withdrawal is globally owed exactly once.
- If the destination bridge has enough available USDC, the signing service signs a withdrawal authorization for that destination bridge.
- If the destination bridge lacks enough USDC, the bridge service starts a rebalance from another configured escrow chain before signing the public payout.
- Rebalancing changes public escrow distribution only; it must not mint or burn shadow USDC.
- A withdrawal authorization is bound to `(withdrawalId, destinationChainId, destinationBridge, amount, recipient, nonce, deadline)` so it cannot be replayed on another chain or bridge.

Recommended rebalance priority for USDC:

1. Circle CCTP, if both chains support native USDC burn/mint for the route.
2. Chainlink CCIP, if the route is supported and operationally simpler for the demo.
3. LI.FI, as the aggregator fallback when the preferred canonical route is unavailable.

The rebalance state machine is separate from the withdrawal state machine:

```text
not_needed | required -> route_selected -> source_transfer_submitted -> destination_funded -> ready_to_sign
                     \-> failed_needs_operator_reconcile
```

Double-spend prevention depends on order, not on destination-chain liquidity:

1. User signs command.
2. Shadow USDC is burned/reserved using a unique withdrawal id.
3. Optional public escrow rebalance completes.
4. Signing service signs exactly one destination-chain withdrawal authorization.
5. User or relayer submits payout on the destination bridge.

If rebalancing fails after the shadow burn, the withdrawal stays pending/retriable; it must not recreate shadow balance automatically unless an explicit admin/user-cancel recovery path burns the pending withdrawal record and restores the shadow balance with an auditable event.


### 7.6 Public Withdrawal Payload

Suggested payload signed by service:

```text
WithdrawalAuthorization {
  gameId
  owner
  shadowAccount
  amount
  recipient
  destinationChainId
  destinationBridge
  userCommandHash
  shadowBurnTxHash
  nonce
  deadline
  bridgeContract
  chainId
}
```

### 7.7 Emergency Withdrawal

Emergency withdrawal remains available through multisig/admin transaction.

Use cases:

- signing service outage
- shadow chain unrecoverable failure
- bridge service critical bug
- legal/compliance/security emergency

Rules:

- Emergency path should be paused-by-default or role-gated.
- Multisig action must emit explicit `EmergencyWithdrawal` events.
- Emergency withdrawals should use the best available accounting snapshot.
- Emergency path is not part of normal UX.

## 8. Registration Commitments

Funding and registration are separate from deposits. Users can add funds later.

Required registration commitment fields:

- `gameId`
- `agentId`
- `owner`
- `shadowAccount`
- `ensName` or `ensNode`
- `instructionHash`
- `runtimeHash`
- `revealSaltHash`
- `createdAt`

Registration freeze, if used, freezes new agents or instruction updates. It should not freeze deposits or withdrawals unless the bridge is paused.

## 10. Public Bridge Contract Interface

Candidate Solidity interface:

```solidity
interface IDarkBoxBridge {
    event AgentRegistered(
        bytes32 indexed gameId,
        bytes32 indexed agentId,
        address indexed owner,
        bytes32 shadowAccount,
        string ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    );

    event DepositReceived(
        bytes32 indexed gameId,
        address indexed owner,
        uint256 amount,
        address beneficiary,
        bytes32 depositRef
    );

    event WithdrawalExecuted(
        bytes32 indexed gameId,
        address indexed owner,
        uint256 amount,
        address recipient,
        uint256 nonce,
        bytes32 userCommandHash,
        bytes32 shadowBurnRef
    );

    event EmergencyWithdrawal(
        bytes32 indexed gameId,
        address indexed owner,
        uint256 amount,
        address recipient,
        bytes32 reason
    );

    function registerAgent(
        bytes32 gameId,
        bytes32 agentId,
        bytes32 shadowAccount,
        string calldata ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    ) external;

    function deposit(
        bytes32 gameId,
        uint256 amount,
        address beneficiary,
        bytes32 depositRef
    ) external;

    function withdraw(
        bytes32 gameId,
        address owner,
        bytes32 shadowAccount,
        uint256 amount,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes32 userCommandHash,
        bytes32 shadowBurnRef,
        bytes calldata serviceSignature
    ) external;

    function emergencyWithdraw(
        bytes32 gameId,
        address owner,
        uint256 amount,
        address recipient,
        bytes32 reason
    ) external;
}
```

Notes:

- Non-USDC balances are not supported. The bridge, shadow chain, and indexer must not model multiple collateral assets for the MVP.
- Direct ERC-20 transfers do not call `deposit(...)`; the offchain watcher must detect allowlisted tokens from token `Transfer` events and ignore all other token contracts.
- `deposit(...)` exists for approve + deposit UX and composed flows such as LI.FI.

## 11. Shadow EVM Bridge Controller Interface

Candidate shadow-side interface:

```solidity
interface IShadowBridgeController {
    event ShadowAccountMapped(address indexed owner, bytes32 indexed shadowAccount);
    event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, uint256 amount);
    event ShadowWithdrawalLocked(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, uint256 amount);
    event ShadowBurned(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, uint256 amount);

    function mapShadowAccount(address owner, bytes32 shadowAccount) external;

    function mintShadow(
        bytes32 depositOpId,
        address owner,
        bytes32 shadowAccount,
        uint256 amount
    ) external;

    function burnForWithdrawal(
        bytes32 withdrawalId,
        address owner,
        bytes32 shadowAccount,
        uint256 amount,
        bytes32 userCommandHash
    ) external;

    function withdrawableBalance(bytes32 shadowAccount) external view returns (uint256);
}
```

## 12. Bridge Service API

Public endpoints exposed by `darkbox-bridge`:

- `POST /api/deposit-intents`
  - optional helper for app/composed flows
  - returns bridge address, deposit calldata, or tracking reference
- `GET /api/deposits/:depositOpId`
  - returns deposit status and credited shadow account
- `GET /api/accounts/:owner`
  - returns mapped shadow account and public-safe balances
- `GET /api/withdrawable/:owner`
  - returns withdrawable available balances only
- `POST /api/withdrawals/commands`
  - accepts user-signed withdrawal command
  - submits/monitors shadow burn
  - returns status and, when ready, signing-service authorization
- `GET /api/withdrawals/:withdrawalId`
  - returns withdrawal status

Internal endpoints, not public:

- `POST /internal/deposits/reconcile`
- `POST /internal/withdrawals/reconcile`
- `POST /internal/shadow-mints/retry`
- `POST /internal/shadow-burns/retry`
- `POST /internal/signing-service/sign-withdrawal`

The public frontend must never receive internal reconciliation data that reveals hidden trades, positions, or per-market PnL before reveal.

## 13. Bridge Worker Responsibilities

Workers:

- public chain watcher for USDC ERC-20 transfers and explicit deposits
- provider/webhook normalizer, if sponsor UX is used
- shadow account mapper
- shadow mint submitter
- withdrawal command validator
- shadow burn/transfer submitter
- signing-service requester
- reconciliation worker

Required persistence:

- deposit intents
- observed public deposit operations
- owner to shadow account mappings
- shadow mint transaction hashes
- withdrawal commands
- user command hashes
- shadow burn transaction hashes
- signing-service authorizations
- retry counts

Local-first storage can be Postgres or SQLite for MVP. If using SQLite locally, keep the schema compatible with Postgres for CVM deployment.

## 14. Docker / CVM Deployment

`darkbox-bridge` runs as its own container, but it does not need a dedicated CVM for the MVP. It should cohabit with the hidden stack inside the private CVM/security boundary because it needs internal access to the shadow node/controller and indexer state, plus egress to Base RPC.

Do not run `darkbox-bridge` in the public frontend container. Public routes may proxy a narrow bridge API, but the bridge process itself belongs on the private side.

`darkbox-signer` may be a separate container or an internal module for MVP. Prefer a separate container if time allows, because it has a distinct key boundary. If a second CVM/enclave is available later, the signer is the component most worth isolating; the bridge container can remain co-located with the hidden node/indexer.

Required networks:

- `public_net`: frontend/API ingress for public endpoints
- `cvm_net`: internal calls to indexer/shadow node
- `egress_net`: public chain RPC, onboarding provider API, Base RPC

Required secrets:

- public chain RPC URL
- signing-service private key or signer-service credentials
- shadow bridge coordinator key
- emergency multisig/admin config
- provider API keys/webhook secret, if used
- database credentials

Required environment variables:

```text
GAME_ID=
BASE_CHAIN_ID=8453
USDC_ADDRESS=
BRIDGE_ADDRESS=
PUBLIC_RPC_URL=
SHADOW_RPC_URL=
SHADOW_BRIDGE_CONTROLLER_ADDRESS=
SIGNER_ADDRESS=
CONFIRMATIONS_REQUIRED=3
FUNDING_PROVIDER=direct|blink|privy|dynamic|lifi
DATABASE_URL=
```

## 15. Security Invariants

- Public withdrawals require both user command signature and signing-service authorization.
- Signing-service authorization requires confirmed shadow burn/transfer first.
- Withdrawals can only consume withdrawable available balance; they must never liquidate or cancel positions implicitly.
- Public deposits across Base and Arc can mint shadow USDC only once.
- Direct ERC-20 transfers must be reconciled from canonical token events on the configured source chain, not trusted client reports.
- Provider webhooks are advisory until reconciled against canonical public-chain/provider state.
- Owner-to-shadow mapping must be enforced consistently on deposits, withdrawals, and agent control.
- Public APIs must not expose hidden balances beyond user-owned available balance and allowed leaderboard aggregates.
- Accounts flagged as invite-bonus recipients must be rejected for withdrawals until Sunday 17:00 event-local time.
- Emergency withdrawal is multisig/admin-only and must be auditable.
- Coordinator and signer keys must be injected as Docker secrets or CVM-sealed secrets, never baked into images.
- Destination-chain withdrawal signing must happen only after shadow burn/reservation and any required destination liquidity rebalance are confirmed.

## 16. MVP Implementation Plan

1. Implement public bridge contract with `deposit(amount, beneficiary)`, signer-authorized `withdraw(...)`, and multisig `emergencyWithdraw(...)`. USDC is the only supported asset; no secondary asset path.
2. Implement shadow bridge controller with owner mapping, idempotent shadow mint, withdrawable-balance check, and burn/lock for withdrawal.
3. Implement bridge watchers for Base and Arc direct USDC `Transfer` events and explicit deposit calls.
4. Implement disposable invite code/link claims with $5 promo shadow USDC mints, one-claim guards, expiry/revocation, promo-vs-real accounting, and a Sunday 17:00 event-local withdrawal unlock for bonus recipients.
5. Implement per-chain escrow accounting and withdrawal destination-chain selection.
6. Implement rebalance worker for destination-chain liquidity shortfalls using Circle CCTP first when available, then Chainlink CCIP or LI.FI fallback.
7. Implement shadow account mapping and immediate minting after confirmed public deposits or invite claims.
5. Implement user EIP-712 withdrawal command flow.
6. Implement shadow burn/transfer worker.
7. Implement signing service authorization after burn confirmation.
8. Implement frontend deposit and available-balance withdrawal UX.
9. Add one sponsor/composed deposit adapter only if it improves demo/bounty fit.

## 17. Demo Script

- User opens a disposable invite link or connects wallet directly.
- User registers an agent and receives/creates a shadow account mapping.
- If using an invite, the system mints $5 promo shadow USDC so the agent can play immediately.
- Otherwise, user sends USDC directly to bridge or uses approve + `deposit(amount, beneficiary)`.
- Bridge detects the operation and mints shadow USDC to the mapped shadow account.
- Agent trades with shadow USDC inside the shadow EVM.
- User sees withdrawable available balance.
- User signs a withdrawal command for part of the idle balance.
- Bridge forces a shadow burn/transfer for that amount.
- Signing service returns withdrawal authorization.
- User submits the withdrawal transaction and receives public USDC.
- If normal signing fails, multisig emergency withdrawal remains available.
