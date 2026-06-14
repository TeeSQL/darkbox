#!/bin/sh
# One-shot DarkBox/Frontier contract deployer, run INSIDE the core CVM (shares
# the sidecar netns → reaches geth-1 at localhost:8545). Waits for the clique
# chain to start sealing, deploys via DeployDarkBox (slimmed EIP-170-safe book +
# 1% taker fee default), prints the emitted addresses, then exits. restart: "no".
set -eu
RPC="${RPC_URL:-http://localhost:8545}"

echo "[deployer] waiting for geth to seal a block at $RPC ..."
i=0
until n="$(cast block-number --rpc-url "$RPC" 2>/dev/null)" && [ -n "${n:-}" ] && [ "$n" -ge 1 ] 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "[deployer] geth not sealing after ~6min — aborting"; exit 1; fi
  sleep 3
done
MODE="${MODE:-deploy}"
if [ "$MODE" = "seed" ]; then
  echo "[deployer] geth sealing (block $n). MODE=seed -> seeding live agent trading on chain 88813 ..."
  # SeedAgentTrading reads DEPLOYER_KEY (minter/coordinator) + DAEMON_SEED + SEED_* from env.
  # Coordinator-funded demo liquidity: funds per-daemon accounts, splits collateral,
  # places real maker/taker orders so the indexer ingests actual fills/pricing — not
  # just logged intents. Simulated (so the router quote reflects the placed asks).
  forge script script/SeedAgentTrading.s.sol:SeedAgentTrading \
    --rpc-url "$RPC" --broadcast -vvv
  echo "[deployer] ===== SEED TRADING COMPLETE ====="
else
  echo "[deployer] geth sealing (block $n). Deploying DarkBox + Frontier onto chain 88813 ..."
  # DeployDarkBox reads DEPLOYER_KEY + TAKER_FEE_BPS(=100 default)/MAKER_FEE_BPS(=0) from env.
  forge script script/DeployDarkBox.s.sol:DeployDarkBox \
    --rpc-url "$RPC" --broadcast --skip-simulation -vvv
  echo "[deployer] ===== DEPLOYMENT COMPLETE ====="
  cat deployments/darkbox-latest.json 2>/dev/null || echo "[deployer] (no artifact file; addresses are in the log above)"
fi
echo "[deployer] done — container will exit."
