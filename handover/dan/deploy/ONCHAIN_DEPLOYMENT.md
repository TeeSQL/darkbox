# DarkBox Onchain Deployment Runbook

Last reviewed: 2026-06-13 UTC  
Repo path: `/home/xiko/darkbox`  
Audience: Dan + Dan's agent

## 1. What exists right now

### Contracts in repo
- `packages/contracts/src/DarkBoxBridge.sol`
  - Public escrow/bridge contract for one configured USDC token.
  - Supports:
    - deposits via `deposit(gameId, amount, beneficiary, depositRef)`
    - agent registration event emission via `registerAgent(...)`
    - permissionless withdrawals authorized by service EIP-712 signature via `withdraw(...)`
    - admin emergency withdrawals
    - admin rotation + pause controls
- `packages/contracts/src/ShadowBridgeController.sol`
  - Shadow-chain ledger/controller.
  - Supports:
    - immutable owner ↔ shadow-account mapping
    - idempotent shadow mint per `depositOpId`
    - burn-for-withdrawal gated by coordinator
    - locked-balance accounting for withdrawable checks
    - coordinator rotation
- `packages/contracts/src/mocks/MockERC20.sol`
  - Test-only mock USDC.

### Deployment scripts in repo
- `packages/contracts/script/Deploy.s.sol`
  - `DeployPublic`: deploys `DarkBoxBridge` and optionally `MockERC20`
  - `DeployShadow`: deploys `ShadowBridgeController`

### Recorded deployment artifacts found
- Base mainnet deployment artifact exists:
  - `packages/contracts/broadcast/Deploy.s.sol/8453/run-latest.json`
  - deployed `DarkBoxBridge` address: `0x55E84818FCEDc3E892A22b46715Ee2B4A947E138`
- Matching config hints found in `.secrets/base-bridge.env`

### Test status
- Ran `pnpm --filter @darkbox/contracts test`
- Result: **35/35 tests passing**
- Coverage includes deposits, withdrawals, EIP-712 digest parity, admin controls, mapping/mint/burn, and locked-balance withdrawal checks.

## 2. What does NOT exist yet

These are important gaps Dan should assume are still open:
- No Frontier/orderbook contracts are vendored or deployed from this repo.
- No hidden-chain market factory / market contracts are present in `packages/contracts`.
- No real bridge coordinator service implementation exists yet in `services/bridge/` (container is placeholder-only).
- No signing-service implementation exists yet.
- No real hidden-chain node image/config exists yet (`infra/node/Dockerfile` is placeholder-only).
- No real ENS deployment/integration implementation exists yet (`services/ens/` placeholder).
- No reveal settlement/export onchain helper contracts exist.
- No Base Sepolia deployment artifact is present in repo yet.
- No Arc deployment artifact is present in repo yet.
- No hidden/private-chain deployment automation beyond `DeployShadow` exists.
- No multisig ownership handoff transaction bundle/scripts are checked in.

## 3. Contract responsibilities and trust model

### 3.1 Public side: `DarkBoxBridge`
This contract is intended for Base / Arc style public escrow chains.

Trust assumptions:
- `admin` is powerful:
  - can rotate signer
  - can pause deposits/withdrawals
  - can execute emergency withdrawals
- `signer` authorizes normal withdrawals after the offchain system confirms shadow burn on the hidden chain.
- Funds are only as safe as:
  - admin key security
  - signer key security
  - correctness of the offchain bridge logic

### 3.2 Hidden side: `ShadowBridgeController`
This contract is intended for the hidden chain / CVM chain.

Trust assumptions:
- `coordinator` is fully trusted to:
  - create owner ↔ shadow mappings
  - mint shadow balances after real deposit or promo credit
  - burn shadow balances before public withdrawal
  - mark balances as locked/unlocked
- This is not a trustless bridge. It is an operator-controlled MVP ledger.

## 4. Confirmed Base mainnet deployment

From `packages/contracts/broadcast/Deploy.s.sol/8453/run-latest.json`:
- Chain ID: `8453`
- Bridge address: `0x55E84818FCEDc3E892A22b46715Ee2B4A947E138`
- Constructor args recorded there indicate:
  - admin: `0xF053A15C36f1FbCC2A281095e6f1507ea1EFc931`
  - signer: `0xF053A15C36f1FbCC2A281095e6f1507ea1EFc931`
  - USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

Config file `.secrets/base-bridge.env` also references:
- `BASE_RPC_URL=https://mainnet.base.org`
- `BASE_CHAIN_ID=8453`
- `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- `ADMIN_ADDRESS=0x8294Ee744Be7c8B546f44C670a854d5F5B672cCe`
- `SIGNER_ADDRESS=0x8294Ee744Be7c8B546f44C670a854d5F5B672cCe`
- `DEPLOYER_ADDRESS=0x8294Ee744Be7c8B546f44C670a854d5F5B672cCe`

### Important inconsistency
The broadcast artifact and `.secrets/base-bridge.env` do **not** agree on admin/signer/deployer addresses.
Dan should treat this as an immediate reconciliation item before any live use.

## 5. Environment variables Dan's agent needs

### 5.1 Public bridge deploy (`DeployPublic`)
Required:
- `PRIVATE_KEY` — deployer private key
- `SIGNER_ADDRESS` — withdrawal signing-service address

Optional / conditionally required:
- `ADMIN_ADDRESS` — defaults to deployer if omitted
- `DEPLOY_MOCK_USDC=true` — deploy mock token instead of using real USDC
- `USDC_ADDRESS` — required if not deploying mock USDC
- `ETH_RPC_URL` or `BASE_RPC_URL` / target RPC passed to Forge via `--rpc-url`

### 5.2 Hidden/shadow deploy (`DeployShadow`)
Required:
- `PRIVATE_KEY` — deployer private key

Optional:
- `COORDINATOR_ADDRESS` — defaults to deployer if omitted
- hidden-chain RPC URL passed through Forge `--rpc-url`

### 5.3 Offchain services that still need env design/implementation
These are not fully implemented in repo, but Dan's agent should budget for them:
- hidden bridge coordinator
- public deposit watcher
- withdrawal signing service
- replay/reconcile worker
- indexer → bridge internal auth
- bridge → shadow-chain RPC
- bridge → public chain RPC(s)
- TEE/CVM secret injection

Expected env surface will likely need:
- `BASE_RPC_URL`
- `ARC_RPC_URL`
- `SHADOW_RPC_URL`
- `BRIDGE_ADDRESS_BASE`
- `BRIDGE_ADDRESS_ARC`
- `SHADOW_BRIDGE_CONTROLLER_ADDRESS`
- `BRIDGE_SIGNER_PRIVATE_KEY`
- `BRIDGE_ADMIN_ADDRESS`
- `SHADOW_COORDINATOR_PRIVATE_KEY`
- `GAME_ID`
- `USDC_ADDRESS_BASE`
- `USDC_ADDRESS_ARC`
- DB/indexer internal URLs

## 6. Ownership/admin recommendations

### Current safe recommendation
Do **not** leave production-like funds behind a single EOA for admin + signer + deployer.

Recommended split:
- `admin` = multisig / operator-controlled safe
- `signer` = dedicated withdrawal service key
- `deployer` = one-time deployment key, retired after ownership handoff
- `coordinator` = dedicated hidden-side service key

### Minimum post-deploy hardening checklist
After any deployment, Dan's agent should verify and document:
- `bridge.admin()`
- `bridge.signer()`
- `bridge.usdc()`
- `bridge.depositsPaused()`
- `bridge.withdrawalsPaused()`
- `shadow.coordinator()`
- expected chain ids match signed-domain assumptions
- signer key is not reused as admin key

## 7. Private hidden-chain deployment flow

This is the intended flow from the code/specs, even though supporting infra is still incomplete.

### Goal
Deploy `ShadowBridgeController` to the hidden chain that hosts Frontier + game accounting.

### Steps
1. Start hidden chain / private EVM.
   - Current repo gap: `infra/node/` is placeholder only.
   - Dan's agent must choose and implement Reth/Geth/Anvil/CVM-compatible node config.
2. Obtain hidden-chain RPC URL.
3. Select coordinator address.
   - Prefer a dedicated service key, not deployer.
4. Export env:
   - `PRIVATE_KEY=<hidden chain deployer key>`
   - `COORDINATOR_ADDRESS=<hidden coordinator address>`
5. Run deploy:
   - `forge script packages/contracts/script/Deploy.s.sol:DeployShadow --rpc-url $SHADOW_RPC_URL --broadcast`
6. Save artifacts:
   - deployment tx hash
   - controller address
   - chain id
   - deploy commit SHA
7. Feed deployed controller address into future bridge/indexer env.
8. Verify coordinator + mapping/mint/burn smoke tests against the deployed contract.

### Hidden-chain gaps to solve before real use
- actual chain bootstrapping
- Frontier deployment
- market contracts deployment
- bridge coordinator service
- replay/reconciliation scripts
- secret management inside CVM/TEE

## 8. Base / Arc public bridge deployment flow

### Base mainnet
Base mainnet already appears deployed once, but needs reconciliation.

Suggested re-verification flow:
1. Set RPC:
   - `export BASE_RPC_URL=https://mainnet.base.org`
2. Confirm deployed bytecode exists at:
   - `0x55E84818FCEDc3E892A22b46715Ee2B4A947E138`
3. Read contract config onchain:
   - `admin()`
   - `signer()`
   - `usdc()`
4. Compare against intended operator values.
5. If incorrect, redeploy or rotate signer/admin immediately.

### Base fresh deploy command
```bash
cd /home/xiko/darkbox/packages/contracts
source ../../.secrets/base-bridge.env
forge script script/Deploy.s.sol:DeployPublic \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast
```

### Arc deployment flow
No Arc-specific files were found in repo.
Dan's agent will need:
1. Arc RPC URL
2. canonical Arc USDC address
3. deployer funded on Arc
4. separate deploy artifact path / env file
5. post-deploy solvency/reconciliation logic shared with Base

Suggested env file shape:
- `.secrets/arc-bridge.env`
  - `ARC_RPC_URL=...`
  - `ARC_CHAIN_ID=...`
  - `USDC_ADDRESS=...`
  - `ADMIN_ADDRESS=...`
  - `SIGNER_ADDRESS=...`
  - `DEPLOYER_ADDRESS=...`

Then run same Forge script with Arc RPC.

## 9. Base Sepolia testnet flow

## Current status
- Fran requested a Base Sepolia deployment.
- No Base Sepolia deployment artifact is present in the repo snapshot I inspected.
- I did **not** perform deployment from this subagent.

## Required inputs before Dan's agent can run it
- Base Sepolia RPC URL
- Base Sepolia USDC or mock-USDC choice
- funded deployer key
- desired admin address
- desired signer address

## Recommended approaches

### Option A: fastest smoke test with mock USDC
Use `DEPLOY_MOCK_USDC=true`.
Pros:
- no dependency on official testnet USDC
- easiest end-to-end testing

Command pattern:
```bash
cd /home/xiko/darkbox/packages/contracts
export PRIVATE_KEY=<sepolia_deployer_pk>
export SIGNER_ADDRESS=<withdrawal_signer>
export ADMIN_ADDRESS=<admin>
export DEPLOY_MOCK_USDC=true
forge script script/Deploy.s.sol:DeployPublic \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

### Option B: use actual Base Sepolia USDC
Set:
- `DEPLOY_MOCK_USDC=false`
- `USDC_ADDRESS=<base_sepolia_usdc>`

Then run the same command.

## After deploy, record
- bridge address
- mock/real token address
- tx hash
- block number
- chain id
- signer/admin values
- test deposit + signed withdrawal results

## 10. Verification steps after any deployment

### Public bridge verification
- call `usdc()`
- call `admin()`
- call `signer()`
- call `depositsPaused()` / `withdrawalsPaused()`
- run a tiny deposit test with mock or test USDC
- create an EIP-712 withdrawal authorization and test withdrawal
- confirm nonce replay protection

### Shadow controller verification
- call `coordinator()`
- test `mapShadowAccount`
- test `mintShadow`
- test `setLocked`
- test `withdrawableBalance`
- test `burnForWithdrawal`

## 11. Audit-relevant deployment risks

Highest-risk issues Dan should assume remain open:
- signer/admin centralization
- bridge service not implemented yet
- no slashing/merkle/fraud-proof model; operator trust is total
- hidden/public accounting reconciliation not implemented yet
- no real chain deployment scripts for Frontier side
- secret handling for deployer/signer/coordinator still unresolved
- promo-credit withdrawal lock exists in spec only, not in Solidity currently
- withdrawals-disabled-during-live-play rule exists in spec/process, not as time-based contract enforcement

## 12. Concrete files Dan's agent should inspect first
- `packages/contracts/src/DarkBoxBridge.sol`
- `packages/contracts/src/ShadowBridgeController.sol`
- `packages/contracts/script/Deploy.s.sol`
- `packages/contracts/test/DarkBoxBridge.t.sol`
- `packages/contracts/test/ShadowBridgeController.t.sol`
- `docs/DEPOSITS_WITHDRAWALS_SPEC.md`
- `docs/TECH_SPEC.md`
- `docker-compose.yml`

## 13. Recommended next actions
1. Reconcile the Base deployment/operator address mismatch.
2. Produce `.secrets/base-sepolia-bridge.env` and deploy there.
3. Implement real `services/bridge` coordinator/watcher/signer stack.
4. Implement hidden node + Frontier deployment automation.
5. Add deployment manifest docs for Arc + hidden chain.
6. Hand off admin to multisig and signer to isolated service key.
## Base Sepolia deployment completed by Ocean

See `BASE_SEPOLIA_DEPLOYMENT.md`.

- `DarkBoxBridge`: `0xe0004c955721b3A994E94CCcA86d91Da4Cf2E6f9`
- `MockERC20` test USDC: `0x8C885Cb844362Ed8d161792aEA6745d29d839246`
- Deployer/admin/signer: `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D`
- Broadcast artifact: `packages/contracts/broadcast/Deploy.s.sol/84532/run-latest.json`
