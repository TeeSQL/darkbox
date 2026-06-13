#!/usr/bin/env bash
# Stands up the DarkBox *private hidden chain* locally and deploys + smoke-tests
# the full Frontier + DarkBox stack on it.
#
# Why anvil and not geth/reth:
#   The real Frontier `GeometricFrontierBook` runtime is ~25-26 KB even at
#   maximum size optimization (optimizer-runs=1 -> 25,228 B), which exceeds the
#   EIP-170 24,576 B contract-code limit. That limit is a hard-coded consensus
#   constant in go-ethereum and reth (revm) and is NOT genesis-configurable, so
#   neither geth nor reth can host the real Frontier book. anvil exposes
#   `--code-size-limit`, and the DarkBox hidden chain controls its own genesis,
#   so anvil (foundry's production-grade local EVM node) is the fastest reliable
#   private-chain path here. The chain is configured with a dedicated chain-id,
#   private-only host binding, interval mining, and on-disk state persistence.
#
# Usage: bash infra/node/run-hidden-chain-e2e.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_DIR="$REPO/infra/node/data"
mkdir -p "$DATA_DIR"

export PORT=8545
export CHAIN_ID=88813                       # DarkBox hidden chain id
export CODE_SIZE_LIMIT=60000
export BLOCK_TIME=1                          # realistic interval mining
export STATE_FILE="$DATA_DIR/hidden-chain-state.json"
export DEPLOY_OUT="deployments/darkbox-private-88813.json"

exec bash "$REPO/packages/contracts/script/live-anvil-e2e.sh"
