#!/usr/bin/env bash
# Local end-to-end smoke test: boots a single anvil (used as BOTH the public and
# shadow chain), deploys DarkBoxBridge + mock USDC + ShadowBridgeController, then
# runs the deposit -> mint -> burn -> authorization -> withdraw flow.
#
# Requires: anvil + forge on PATH, pnpm. No secrets — uses anvil's well-known
# dev accounts. This is the zero-config rehearsal for the real testnet run.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/packages/contracts"
RPC="http://127.0.0.1:8545"

# anvil default dev accounts (public test keys — local only).
ACCT0_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # deployer/coordinator
ACCT0_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ACCT1_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # signer
ACCT1_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ACCT2_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a # user

GAME_ID=0x0000000000000000000000000000000000000000000000000000000000000001

cleanup() { [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> starting anvil"
anvil --silent --chain-id 31337 >/dev/null 2>&1 &
ANVIL_PID=$!
# wait for RPC
for _ in $(seq 1 50); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done

echo "==> deploying public bridge + mock USDC"
PUB_OUT=$(cd "$CONTRACTS" && PRIVATE_KEY=$ACCT0_KEY SIGNER_ADDRESS=$ACCT1_ADDR DEPLOY_MOCK_USDC=true \
  forge script script/Deploy.s.sol:DeployPublic --rpc-url "$RPC" --broadcast -vv 2>&1)
BRIDGE_ADDRESS=$(echo "$PUB_OUT" | grep -A1 'DarkBoxBridge:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
USDC_ADDRESS=$(echo "$PUB_OUT" | grep -A1 'MockUSDC:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)

echo "==> deploying shadow controller"
SH_OUT=$(cd "$CONTRACTS" && PRIVATE_KEY=$ACCT0_KEY \
  forge script script/Deploy.s.sol:DeployShadow --rpc-url "$RPC" --broadcast -vv 2>&1)
CONTROLLER_ADDRESS=$(echo "$SH_OUT" | grep -A1 'ShadowBridgeController:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)

echo "    BRIDGE_ADDRESS=$BRIDGE_ADDRESS"
echo "    USDC_ADDRESS=$USDC_ADDRESS"
echo "    SHADOW_BRIDGE_CONTROLLER_ADDRESS=$CONTROLLER_ADDRESS"

[[ -z "$BRIDGE_ADDRESS" || -z "$USDC_ADDRESS" || -z "$CONTROLLER_ADDRESS" ]] && {
  echo "deploy parsing failed"; echo "$PUB_OUT"; echo "$SH_OUT"; exit 1; }

echo "==> running smoke flow"
cd "$ROOT/services/bridge"
PUBLIC_RPC_URL="$RPC" \
SHADOW_RPC_URL="$RPC" \
BASE_CHAIN_ID=31337 \
SHADOW_CHAIN_ID=31337 \
BRIDGE_ADDRESS="$BRIDGE_ADDRESS" \
SHADOW_BRIDGE_CONTROLLER_ADDRESS="$CONTROLLER_ADDRESS" \
USDC_ADDRESS="$USDC_ADDRESS" \
GAME_ID="$GAME_ID" \
USER_PRIVATE_KEY="$ACCT2_KEY" \
COORDINATOR_PRIVATE_KEY="$ACCT0_KEY" \
SIGNER_PRIVATE_KEY="$ACCT1_KEY" \
USDC_IS_MINTABLE=true \
CONFIRMATIONS_REQUIRED=1 \
node --import tsx scripts/smoke.ts
