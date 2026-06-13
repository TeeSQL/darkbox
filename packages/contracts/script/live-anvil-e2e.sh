#!/usr/bin/env bash
# Live end-to-end check on a local Anvil:
#   deploy Frontier + DarkBox -> verify wiring -> split -> maker ask ->
#   taker buy via router -> maker claim -> resolve -> redeem.
# Anvil is started with a raised code-size limit because the real
# GeometricFrontierBook runtime (~26 KB) exceeds the default 24,576 EIP-170 cap;
# the DarkBox hidden chain controls its own genesis, so this is acceptable.
#
# Usage: bash script/live-anvil-e2e.sh        (from packages/contracts)
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# --- parametric config (env-overridable; defaults = throwaway dev anvil) ---
PORT="${PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
CHAIN_ID="${CHAIN_ID:-}"                 # empty => anvil default 31337
CODE_SIZE_LIMIT="${CODE_SIZE_LIMIT:-60000}"
DEPLOY_OUT="${DEPLOY_OUT:-deployments/darkbox-latest.json}"
STATE_FILE="${STATE_FILE:-}"             # if set, persist chain state across runs
BLOCK_TIME="${BLOCK_TIME:-}"            # if set, interval-mine

# anvil deterministic keys
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # acct0: deployer/admin/maker
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # acct1: taker
A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

ANVIL_FLAGS=(--port "$PORT" --code-size-limit "$CODE_SIZE_LIMIT" --host 127.0.0.1 --silent)
[ -n "$CHAIN_ID" ] && ANVIL_FLAGS+=(--chain-id "$CHAIN_ID")
[ -n "$BLOCK_TIME" ] && ANVIL_FLAGS+=(--block-time "$BLOCK_TIME")
if [ -n "$STATE_FILE" ]; then
  ANVIL_FLAGS+=(--dump-state "$STATE_FILE")
  [ -f "$STATE_FILE" ] && ANVIL_FLAGS+=(--load-state "$STATE_FILE")
fi

echo "==> starting anvil (port $PORT, code-size-limit $CODE_SIZE_LIMIT${CHAIN_ID:+, chain-id $CHAIN_ID}${STATE_FILE:+, state $STATE_FILE})"
anvil "${ANVIL_FLAGS[@]}" &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 1; done
echo "    anvil up (chainid $(cast chain-id --rpc-url $RPC))"

echo "==> deploying Frontier + DarkBox + canonical market -> $DEPLOY_OUT"
mkdir -p deployments
DEPLOY_OUT="$DEPLOY_OUT" forge script script/DeployDarkBox.s.sol:DeployDarkBox --rpc-url $RPC --broadcast --slow --non-interactive >/tmp/dbx_deploy.log 2>&1 \
  || { echo "DEPLOY FAILED"; tail -30 /tmp/dbx_deploy.log; exit 1; }
grep -q "ONCHAIN EXECUTION COMPLETE" /tmp/dbx_deploy.log && echo "    deploy on-chain OK"

J() { python3 -c "import json;d=json.load(open('$DEPLOY_OUT'));print($1)"; }
SUSDC=$(J "d['darkbox']['syntheticUSDC']");   PMF=$(J "d['darkbox']['marketFactory']")
FRONTIER=$(J "d['frontier']['factory']");     ROUTER=$(J "d['frontier']['router']")
MARKET=$(J "d['canonicalMarket']['market']"); MID=$(J "d['canonicalMarket']['marketId']")
YES=$(J "d['canonicalMarket']['yesToken']");  YESBOOK=$(J "d['canonicalMarket']['yesBook']")
DL=$(( $(date +%s) + 3600 ))

pass=0; fail=0
# cast prints large uints as "100000000 [1e8]"; keep only the raw integer.
num() { echo "$1" | awk '{print $1}'; }
bal() { num "$(cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url $RPC)"; }
chk() { if [ "$2" = "$3" ]; then echo "    PASS $1"; pass=$((pass+1)); else echo "    FAIL $1 ($2 != $3)"; fail=$((fail+1)); fi; }
gt()  { local a; a=$(num "$2"); if [ "$a" -gt "$3" ]; then echo "    PASS $1 ($a > $3)"; pass=$((pass+1)); else echo "    FAIL $1 ($a <= $3)"; fail=$((fail+1)); fi; }

echo "==> verify deployment"
chk "frontier bookCount==2" "$(cast call $FRONTIER 'bookCount()(uint256)' --rpc-url $RPC)" "2"
gt  "yesBook has code" "$(cast codesize $YESBOOK --rpc-url $RPC)" "0"
chk "yesBook token0==YES" "$(cast call $YESBOOK 'token0()(address)' --rpc-url $RPC)" "$YES"
chk "yesBook token1==sUSDC" "$(cast call $YESBOOK 'token1()(address)' --rpc-url $RPC)" "$SUSDC"
chk "market Active" "$(cast call $MARKET 'status()(uint8)' --rpc-url $RPC)" "1"

echo "==> maker ask (deployer already holds 1000e6 YES from initial liquidity)"
cast send $YES 'approve(address,uint256)(bool)' $YESBOOK "$(cast max-uint)" --private-key $K0 --rpc-url $RPC >/dev/null
cast send $YESBOOK 'deposit(int24,int24,uint128)(uint256)' 1 101 1000000 --private-key $K0 --rpc-url $RPC >/dev/null
gt "book escrowed YES" "$(bal $YES $YESBOOK)" "0"

echo "==> taker buys YES with sUSDC via router"
cast send $SUSDC 'mint(address,uint256)' $A1 1000000000 --private-key $K0 --rpc-url $RPC >/dev/null
cast send $SUSDC 'approve(address,uint256)(bool)' $ROUTER "$(cast max-uint)" --private-key $K1 --rpc-url $RPC >/dev/null
cast send $ROUTER 'buyExactIn(address,uint256,uint256,address,uint256)(uint256,uint256)' \
  $YESBOOK 50000000 0 $A1 $DL --private-key $K1 --rpc-url $RPC >/dev/null
gt "taker received YES" "$(bal $YES $A1)" "0"

echo "==> resolve canonical market YES and redeem"
cast send $PMF 'resolveMarket(bytes32,uint8,bytes32)' $MID 1 "$(cast keccak resolution)" --private-key $K0 --rpc-url $RPC >/dev/null
chk "market Resolved" "$(cast call $MARKET 'status()(uint8)' --rpc-url $RPC)" "4"
TAKER_YES=$(bal $YES $A1)
SU_BEFORE=$(bal $SUSDC $A1)
cast send $MARKET 'redeem(uint8,uint256,address)(uint256)' 1 "$TAKER_YES" $A1 --private-key $K1 --rpc-url $RPC >/dev/null
SU_AFTER=$(bal $SUSDC $A1)
gt "taker redeemed winning YES for sUSDC" "$SU_AFTER" "$SU_BEFORE"

echo "==> RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
