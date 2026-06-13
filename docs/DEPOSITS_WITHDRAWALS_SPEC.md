# Deposits + Withdrawals Specification

## 1. Decision

DarkBox uses a public bridge/escrow contract for real assets and a shadow asset inside the local shadow EVM for in-game accounting.

Users may deposit into or withdraw from their agent at any time, with one constraint: withdrawals can only use withdrawable available balance. Users cannot force liquidation of open orders or positions.

For the hackathon MVP:

- Canonical public assets: USDC first, ETH optional if useful for demo/onboarding.
- Canonical escrow chain: Base unless a sponsor flow requires another settlement chain.
- Public contract: accepts direct sends/transfers and explicit deposit function calls.
- Shadow EVM: mints/burns corresponding shadow USDC/shadow ETH for the user's mapped shadow account.
- Ownership mapping: every shadow account maps to an onchain owner wallet.
- Withdrawals: user signs a withdrawal command; the system forces the agent/shadow account to burn or transfer shadow funds in the shadow EVM; a signing service authorizes public escrow withdrawal.
- Emergency withdrawal: retained through multisig/admin transaction path.

There are no Merkle claims in the normal withdrawal path. Withdrawals are online, signing-service authorized bridge exits against available shadow balance.

## 2. Goals

- Let users top up or withdraw available agent funds any time.
- Keep real assets custodied in the public bridge/escrow contract.
- Keep strategy risk intact: users can withdraw idle balance but cannot liquidate active positions through the bridge.
- Make every shadow mint traceable to a public deposit operation.
- Make every public withdrawal traceable to a user-signed command and a shadow-EVM burn/transfer.
- Keep the public frontend away from hidden orderbook/trade/position APIs.
- Keep the stack Docker/local-first so the same services can run locally and inside the CVM deployment.

## 3. Non-Goals

- General-purpose bridge custody across many chains.
- Forced liquidation of positions to satisfy withdrawals.
- Public exposure of hidden orderbooks, trades, positions, or per-market PnL.
- Supporting many onboarding providers in the MVP.
- Letting the frontend talk directly to the hidden node or privileged indexer APIs.
- Merkle-claim settlement as the standard withdrawal mechanism.

## 4. Actors

- User: owns an onchain wallet, maps to a shadow account, deposits/withdraws available funds.
- Agent: trades inside the shadow EVM using the user's shadow balance and instructions.
- Frontend: public app; talks only to public bridge/indexer APIs.
- Public bridge contract: custodies real USDC/ETH, records deposits, verifies signing-service withdrawals, supports emergency multisig exits.
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

Real assets stay in the public bridge/escrow contract.

Escrow tracks:

- asset address, or native ETH sentinel
- onchain owner
- optional beneficiary owner
- total deposited
- total withdrawn
- used withdrawal nonces
- emergency status

### 5.3 Shadow Asset Balance

The shadow EVM mints local shadow assets corresponding to public deposits.

Rules:

- Public USDC deposit mints shadow USDC.
- Public ETH deposit mints shadow ETH, if ETH is supported.
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

Users may withdraw only this available amount. If they want more, the agent must voluntarily cancel orders, close positions, or wait for fills/resolution according to normal market rules.

## 6. Deposit Lifecycle

### 6.1 Supported Deposit Paths

DarkBox supports both passive sends and explicit function calls.

1. Direct ETH send:
   - user sends ETH to the public bridge contract
   - contract emits a receive/deposit event where possible
   - offchain system also observes the transaction
   - beneficiary defaults to `msg.sender`

2. Direct USDC transfer:
   - user transfers USDC to the public bridge contract
   - offchain system detects the ERC-20 `Transfer(from, bridge, amount)` event
   - beneficiary defaults to `from`, unless a prior deposit intent maps the transfer to another beneficiary

3. Explicit deposit function:
   - user approves USDC
   - user calls `deposit(asset, amount, beneficiary)`
   - useful for normal app UX and composed flows such as LI.FI

4. Cross-chain/onboarding adapter:
   - provider flow ultimately sends assets to the bridge or calls `deposit(...)`
   - offchain normalizer maps the operation to the beneficiary owner

### 6.2 Deposit State Machine

```text
observed_public_deposit -> confirmed_public_deposit -> mapping_resolved -> shadow_mint_submitted -> shadow_minted
                                                        \-> failed_needs_reconcile
```

Deposits are allowed any time unless the game or bridge is paused.

### 6.3 Deposit Happy Path

1. User sends USDC/ETH to bridge or calls `deposit(asset, amount, beneficiary)`.
2. Bridge watcher detects the operation.
3. Bridge waits for the required confirmation threshold.
4. Bridge resolves beneficiary owner and shadow account mapping.
5. If needed, bridge creates/updates the shadow account mapping in the shadow EVM.
6. Bridge submits `mintShadow(asset, shadowAccount, amount, depositOpId)` to the shadow bridge controller.
7. Shadow EVM emits `ShadowMinted`.
8. Indexer sees the mint and updates available balance.
9. UI shows the deposit as credited.

### 6.4 Deposit Idempotency

Deposit operation id:

```text
chainId:bridgeAddress:asset:txHash:logIndex:from:beneficiary:amount
```

Rules:

- If the same operation id is seen again, do not mint again.
- If the shadow mint succeeds but bridge crashes before marking success, recover by searching shadow EVM for `ShadowMinted(depositOpId)` before retrying.
- Direct USDC transfers without explicit beneficiary credit the sender by default.
- Deposit intents can override beneficiary only when the observed transfer matches the intent constraints.

## 7. Withdrawal Lifecycle

### 7.1 Withdrawal State Machine

```text
requested -> user_signed -> shadow_burn_submitted -> shadow_burned -> service_signed -> submitted_public_withdrawal -> withdrawn
          \-> rejected_insufficient_available
          \-> failed_needs_reconcile
```

### 7.2 User-Signed Withdrawal Command

When a user wants to withdraw:

1. User connects their owner wallet.
2. UI fetches withdrawable available balance from the public-safe bridge/indexer API.
3. User chooses asset, amount, recipient, and shadow account.
4. User signs an EIP-712 withdrawal command.
5. Bridge treats this signature as a command to the user's agent/shadow account.

The user signature authorizes the system to force a shadow-EVM burn/transfer of idle shadow funds. It does not authorize liquidation of positions.

Suggested EIP-712 fields:

```text
WithdrawCommand {
  gameId
  owner
  shadowAccount
  asset
  amount
  recipient
  nonce
  deadline
  bridgeContract
  shadowChainId
}
```

### 7.3 Forced Shadow Burn / Transfer

After validating the user signature, the bridge submits a shadow-EVM transaction that forces one of:

- burn shadow asset from the user's shadow account, or
- transfer shadow asset from the user's shadow account to a bridge sink account

Rules:

- The shadow bridge controller checks available withdrawable balance.
- It must not cancel orders or liquidate positions.
- It reserves the amount immediately to prevent double-withdrawal.
- It emits `ShadowWithdrawalLocked` or `ShadowBurned` with the withdrawal id.

### 7.4 Signing-Service Public Withdrawal

Once the shadow burn/transfer is confirmed:

1. Bridge asks the signing service for a public withdrawal authorization.
2. Signing service verifies:
   - user EIP-712 signature
   - owner-to-shadow mapping
   - shadow burn/transfer event
   - nonce unused
   - asset/amount/recipient match
3. Signing service returns a signature over the public withdrawal payload.
4. UI receives the signing-service signature.
5. User submits `withdraw(...)` to the public bridge contract.
6. Public bridge verifies signer authorization, marks nonce used, transfers real asset.

This makes withdrawal user-initiated while preserving the invariant that public escrow only releases assets after the corresponding shadow funds are removed from circulation.

### 7.5 Public Withdrawal Payload

Suggested payload signed by service:

```text
WithdrawalAuthorization {
  gameId
  owner
  shadowAccount
  asset
  amount
  recipient
  userCommandHash
  shadowBurnTxHash
  nonce
  deadline
  bridgeContract
  chainId
}
```

### 7.6 Emergency Withdrawal

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

## 9. Public Bridge Contract Interface

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
        address indexed asset,
        uint256 amount,
        address beneficiary,
        bytes32 depositRef
    );

    event WithdrawalExecuted(
        bytes32 indexed gameId,
        address indexed owner,
        address indexed asset,
        uint256 amount,
        address recipient,
        uint256 nonce,
        bytes32 userCommandHash,
        bytes32 shadowBurnRef
    );

    event EmergencyWithdrawal(
        bytes32 indexed gameId,
        address indexed owner,
        address indexed asset,
        uint256 amount,
        address recipient,
        bytes32 reason
    );

    receive() external payable;

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
        address asset,
        uint256 amount,
        address beneficiary,
        bytes32 depositRef
    ) external payable;

    function withdraw(
        bytes32 gameId,
        address owner,
        bytes32 shadowAccount,
        address asset,
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
        address asset,
        uint256 amount,
        address recipient,
        bytes32 reason
    ) external;
}
```

Notes:

- Native ETH uses `asset = address(0)` or an agreed sentinel.
- Direct ERC-20 transfers do not call `deposit(...)`; the offchain watcher must detect them from token `Transfer` events.
- `deposit(...)` exists for approve + deposit UX and composed flows such as LI.FI.

## 10. Shadow EVM Bridge Controller Interface

Candidate shadow-side interface:

```solidity
interface IShadowBridgeController {
    event ShadowAccountMapped(address indexed owner, bytes32 indexed shadowAccount);
    event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount);
    event ShadowWithdrawalLocked(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount);
    event ShadowBurned(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount);

    function mapShadowAccount(address owner, bytes32 shadowAccount) external;

    function mintShadow(
        bytes32 depositOpId,
        address owner,
        bytes32 shadowAccount,
        address asset,
        uint256 amount
    ) external;

    function burnForWithdrawal(
        bytes32 withdrawalId,
        address owner,
        bytes32 shadowAccount,
        address asset,
        uint256 amount,
        bytes32 userCommandHash
    ) external;

    function withdrawableBalance(bytes32 shadowAccount, address asset) external view returns (uint256);
}
```

## 11. Bridge Service API

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

## 12. Bridge Worker Responsibilities

Workers:

- public chain watcher for ETH receives, explicit deposits, and ERC-20 transfers
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

## 13. Docker / CVM Deployment

`darkbox-bridge` runs as its own container.

`darkbox-signer` may be a separate container or an internal module for MVP. Prefer a separate container if time allows, because it has a distinct key boundary.

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

## 14. Security Invariants

- Public withdrawals require both user command signature and signing-service authorization.
- Signing-service authorization requires confirmed shadow burn/transfer first.
- Withdrawals can only consume withdrawable available balance; they must never liquidate or cancel positions implicitly.
- Public deposits can mint shadow assets only once.
- Direct ERC-20 transfers must be reconciled from canonical token events, not trusted client reports.
- Provider webhooks are advisory until reconciled against canonical public-chain/provider state.
- Owner-to-shadow mapping must be enforced consistently on deposits, withdrawals, and agent control.
- Public APIs must not expose hidden balances beyond user-owned available balance and allowed leaderboard aggregates.
- Emergency withdrawal is multisig/admin-only and must be auditable.
- Coordinator and signer keys must be injected as Docker secrets or CVM-sealed secrets, never baked into images.

## 15. MVP Implementation Plan

1. Implement public bridge contract with `receive()`, `deposit(asset, amount, beneficiary)`, signer-authorized `withdraw(...)`, and multisig `emergencyWithdraw(...)`.
2. Implement shadow bridge controller with owner mapping, idempotent shadow mint, withdrawable-balance check, and burn/lock for withdrawal.
3. Implement bridge watcher for direct ETH sends, direct USDC `Transfer` events, and explicit deposit calls.
4. Implement shadow account mapping and immediate minting after confirmed public deposits.
5. Implement user EIP-712 withdrawal command flow.
6. Implement shadow burn/transfer worker.
7. Implement signing service authorization after burn confirmation.
8. Implement frontend deposit and available-balance withdrawal UX.
9. Add one sponsor/composed deposit adapter only if it improves demo/bounty fit.

## 16. Demo Script

- User connects wallet.
- User registers an agent and receives/creates a shadow account mapping.
- User sends USDC directly to bridge or uses approve + `deposit(amount, beneficiary)`.
- Bridge detects the operation and mints shadow USDC to the mapped shadow account.
- Agent trades with shadow USDC inside the shadow EVM.
- User sees withdrawable available balance.
- User signs a withdrawal command for part of the idle balance.
- Bridge forces a shadow burn/transfer for that amount.
- Signing service returns withdrawal authorization.
- User submits the withdrawal transaction and receives public USDC.
- If normal signing fails, multisig emergency withdrawal remains available.
