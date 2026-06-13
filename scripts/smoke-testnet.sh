#!/usr/bin/env bash
# Testnet smoke test: deploys DarkBoxBridge + mintable test USDC to a real public
# testnet, runs ShadowBridgeController on a local anvil (the stand-in for the
# hidden shadow EVM, which has no testnet yet), and executes the full
# deposit -> mint -> burn -> authorization -> withdraw flow.
#
# Requires: anvil + forge + cast on PATH, pnpm, and a funded testnet key.
# Config comes from .env.smoke (see .env.smoke.example).
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/packages/contracts"

# load .env.smoke
ENV_FILE="${ENV_FILE:-$ROOT/.env.smoke}"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE (copy .env.smoke.example)"; exit 1; }
set -a; source "$ENV_FILE"; set +a

: "${PUBLIC_RPC_URL:?set PUBLIC_RPC_URL}"
: "${PUBLIC_CHAIN_ID:?set PUBLIC_CHAIN_ID}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"

SHADOW_RPC="http://127.0.0.1:8546"
SHADOW_CHAIN_ID=31337
GAME_ID=0x0000000000000000000000000000000000000000000000000000000000000001

# Local shadow accounts (anvil dev keys — local only, no real value).
COORD_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# Signer key signs authorizations off-chain (no gas needed); its address is set
# as SIGNER on the deployed bridge.
SIGNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
SIGNER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

cleanup() { [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> starting local shadow anvil on $SHADOW_RPC"
anvil --silent --port 8546 --chain-id "$SHADOW_CHAIN_ID" >/dev/null 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast block-number --rpc-url "$SHADOW_RPC" >/dev/null 2>&1 && break; sleep 0.1; done

echo "==> deploying public bridge + test USDC to chain $PUBLIC_CHAIN_ID"
PUB_OUT=$(cd "$CONTRACTS" && PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY SIGNER_ADDRESS=$SIGNER_ADDR DEPLOY_MOCK_USDC=true \
  forge script script/Deploy.s.sol:DeployPublic --rpc-url "$PUBLIC_RPC_URL" --broadcast -vv 2>&1)
echo "$PUB_OUT" | grep -E 'DarkBoxBridge:|MockUSDC:|signer:' || true
BRIDGE_ADDRESS=$(echo "$PUB_OUT" | grep -A1 'DarkBoxBridge:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
USDC_ADDRESS=$(echo "$PUB_OUT" | grep -A1 'MockUSDC:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)

echo "==> deploying shadow controller to local anvil"
SH_OUT=$(cd "$CONTRACTS" && PRIVATE_KEY=$COORD_KEY \
  forge script script/Deploy.s.sol:DeployShadow --rpc-url "$SHADOW_RPC" --broadcast -vv 2>&1)
CONTROLLER_ADDRESS=$(echo "$SH_OUT" | grep -A1 'ShadowBridgeController:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)

[[ -z "$BRIDGE_ADDRESS" || -z "$USDC_ADDRESS" || -z "$CONTROLLER_ADDRESS" ]] && {
  echo "deploy parsing failed"; echo "$PUB_OUT"; echo "$SH_OUT"; exit 1; }

echo "    BRIDGE_ADDRESS=$BRIDGE_ADDRESS"
echo "    USDC_ADDRESS=$USDC_ADDRESS  (1,000,000 test USDC minted to deployer)"
echo "    SHADOW_BRIDGE_CONTROLLER_ADDRESS=$CONTROLLER_ADDRESS"

echo "==> running smoke flow against the testnet"
cd "$ROOT/services/bridge"
PUBLIC_RPC_URL="$PUBLIC_RPC_URL" \
SHADOW_RPC_URL="$SHADOW_RPC" \
BASE_CHAIN_ID="$PUBLIC_CHAIN_ID" \
SHADOW_CHAIN_ID="$SHADOW_CHAIN_ID" \
BRIDGE_ADDRESS="$BRIDGE_ADDRESS" \
SHADOW_BRIDGE_CONTROLLER_ADDRESS="$CONTROLLER_ADDRESS" \
USDC_ADDRESS="$USDC_ADDRESS" \
GAME_ID="$GAME_ID" \
USER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
COORDINATOR_PRIVATE_KEY="$COORD_KEY" \
SIGNER_PRIVATE_KEY="$SIGNER_KEY" \
RECIPIENT_ADDRESS="${RECIPIENT_ADDRESS:-}" \
AMOUNT_USDC="${AMOUNT_USDC:-100}" \
WITHDRAW_USDC="${WITHDRAW_USDC:-40}" \
CONFIRMATIONS_REQUIRED=1 \
node --import tsx scripts/smoke.ts
