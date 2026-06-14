# Arc Testnet Submission Runbook

Narrative goal: produce verifiable Arc Testnet artifacts showing DarkBox/Daemon Hall first ran as a prototype on Arc: Frontier CLOB contracts, DarkBox prediction-market contracts, funded demo bot accounts, live orderflow, and a repointed Frontier UI.

## Public Arc parameters

- RPC: `https://rpc.testnet.arc.network`
- Chain ID: `5042002`
- Native gas symbol: `USDC`
- Explorer: `https://testnet.arcscan.app`

## Safety boundaries

- Do not expose hidden orderbook internals, raw private agent state, private keys, or privileged indexer APIs.
- Public demo surfaces should use `/public/*` gateway/indexer endpoints only.
- Use fresh funded testnet keys for deploy/seeding. Never use Anvil keys on Arc.
- Keep deployer/operator keys in local secret files or sealed CVM env only; never commit them.

## 0. Prerequisites

Fund these Arc testnet accounts with enough native USDC for gas before broadcasting:

- `DEPLOYER_KEY` account: deploys Frontier + DarkBox + seeds canonical market; also mints demo sUSDC.
- `MAKER_KEY` account: posts small maker liquidity.
- `TAKER_KEY` account: crosses small orders to generate visible activity.

Check balances without printing keys:

```bash
cast balance <address> --rpc-url https://rpc.testnet.arc.network
```

## 1. Build contracts

```bash
cd /home/xiko/darkbox/packages/contracts
forge build --evm-version cancun
```

## 2. Deploy CLOB + prediction market stack

The deploy script deploys:

- Frontier permission registry
- Frontier geometric book factory + book deployers
- Frontier lens + router
- synthetic USDC collateral token
- DarkBox market factory
- canonical binary prediction market
- YES/sUSDC and NO/sUSDC Frontier books

```bash
cd /home/xiko/darkbox/packages/contracts
mkdir -p deployments

DEPLOY_OUT=deployments/darkbox-arc-testnet-5042002.json \
MAKER_FEE_BPS=0 \
TAKER_FEE_BPS=100 \
DEPLOYER_KEY="$DEPLOYER_KEY" \
forge script script/DeployDarkBox.s.sol:DeployDarkBox \
  --rpc-url https://rpc.testnet.arc.network \
  --broadcast \
  --slow \
  --non-interactive \
  --evm-version cancun
```

Expected artifact:

```bash
/home/xiko/darkbox/packages/contracts/deployments/darkbox-arc-testnet-5042002.json
```

Important fields:

- `frontier.factory`
- `frontier.router`
- `frontier.lens`
- `darkbox.syntheticUSDC`
- `darkbox.marketFactory`
- `canonicalMarket.marketId`
- `canonicalMarket.market`
- `canonicalMarket.yesToken`
- `canonicalMarket.noToken`
- `canonicalMarket.yesBook`
- `canonicalMarket.noBook`

## 3. Verify deployment

```bash
DEPLOY_JSON=/home/xiko/darkbox/packages/contracts/deployments/darkbox-arc-testnet-5042002.json
RPC=https://rpc.testnet.arc.network

SUSDC=$(jq -r '.darkbox.syntheticUSDC' "$DEPLOY_JSON")
PMF=$(jq -r '.darkbox.marketFactory' "$DEPLOY_JSON")
FRONTIER=$(jq -r '.frontier.factory' "$DEPLOY_JSON")
YESBOOK=$(jq -r '.canonicalMarket.yesBook' "$DEPLOY_JSON")
NOBOOK=$(jq -r '.canonicalMarket.noBook' "$DEPLOY_JSON")
MID=$(jq -r '.canonicalMarket.marketId' "$DEPLOY_JSON")

cast code "$PMF" --rpc-url "$RPC" | grep -vq '^0x$'
cast code "$SUSDC" --rpc-url "$RPC" | grep -vq '^0x$'
cast code "$YESBOOK" --rpc-url "$RPC" | grep -vq '^0x$'
cast code "$NOBOOK" --rpc-url "$RPC" | grep -vq '^0x$'
cast call "$FRONTIER" 'bookCount()(uint256)' --rpc-url "$RPC"
cast call "$PMF" 'getBooks(bytes32)(address,address)' "$MID" --rpc-url "$RPC"
cast call "$YESBOOK" 'takerFeeBps()(uint16)' --rpc-url "$RPC"
cast call "$NOBOOK" 'takerFeeBps()(uint16)' --rpc-url "$RPC"
```

Expected fee config: maker `0`, taker `100` bps.

## 4. Fund bots and create on-chain noise

Use the Arc seeder script, which requires non-Anvil funded bot keys and refuses zero native gas balances.

```bash
cd /home/xiko/darkbox/packages/contracts

RPC_URL=https://rpc.testnet.arc.network \
CHAIN_ID=5042002 \
DEPLOY_JSON=deployments/darkbox-arc-testnet-5042002.json \
DEPLOYER_KEY="$DEPLOYER_KEY" \
MAKER_KEY="$MAKER_KEY" \
TAKER_KEY="$TAKER_KEY" \
SEED_BASE_UNITS=1000000 \
TAKER_SPEND_UNITS=5000000 \
bash script/seed-arc-orderflow.sh
```

What this does:

- checks chain id and native gas balances
- mints demo sUSDC to maker/taker using the deployer/minter
- transfers small YES/NO inventory from deployer to maker
- posts small YES and NO asks
- executes taker buys through the Frontier router
- prints tx hashes and final balances for narrative evidence

## 5. Generate Frontier UI deployment config

The existing Frontier UI is single-book. Generate one config per book and deploy whichever view should be default.

```bash
cd /home/xiko/darkbox
node scripts/generate-frontier-ui-config.mjs \
  --deploy-json packages/contracts/deployments/darkbox-arc-testnet-5042002.json \
  --rpc-url https://rpc.testnet.arc.network \
  --side yes \
  --out /home/xiko/frontier-worktrees/deploy-ready/ui/public/deployment.json
```

For NO view:

```bash
node scripts/generate-frontier-ui-config.mjs \
  --deploy-json packages/contracts/deployments/darkbox-arc-testnet-5042002.json \
  --rpc-url https://rpc.testnet.arc.network \
  --side no \
  --out /home/xiko/frontier-worktrees/deploy-ready/ui/public/deployment.json
```

Then build:

```bash
cd /home/xiko/frontier-worktrees/deploy-ready/ui
pnpm install
pnpm build
```

Fast demo framing: call this an “advanced Arc CLOB view” for a selected YES/NO book, not the complete consumer prediction-market UI.

## 6. Backend/indexer Arc env sketch

If running DarkBox public APIs against Arc instead of static UI-only evidence:

```bash
HIDDEN_RPC_URL=https://rpc.testnet.arc.network
HIDDEN_CHAIN_ID=5042002
MARKET_FACTORY_ADDRESS=<darkbox.marketFactory>
GAME_ID=0x<keccak darkbox-game-1 if needed by service>
```

Use only public gateway routes in the frontend:

- `/public/markets`
- `/public/activity`
- `/public/leaderboard`

## Submission evidence checklist

Capture these artifacts/screenshots:

- deployment JSON with Arc chain id `5042002`
- Arc explorer links for deploy txs
- `cast code` checks for factory/sUSDC/books
- `bookCount == 2` or higher
- YES/NO book fee checks showing `100` bps taker fee
- bot funding/seeding tx hashes
- UI screenshot showing Arc Testnet + selected YES/NO book
- public activity/leaderboard screenshot if API is wired
