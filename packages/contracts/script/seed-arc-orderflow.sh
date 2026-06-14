#!/usr/bin/env bash
# Seed small, real Frontier orderflow for a deployed DarkBox Arc/Testnet stack.
#
# Requirements:
# - DEPLOYER_KEY: deployed SyntheticUSDC minter and initial canonical-market LP holder
# - MAKER_KEY: funded native-gas account that will post asks
# - TAKER_KEY: funded native-gas account that will cross asks through FrontierRouter
# - DEPLOY_JSON: deployment artifact from DeployDarkBox.s.sol
#
# This script refuses Anvil dev keys and zero native-gas balances. It prints
# public tx hashes/addresses only; never echo private keys.
set -euo pipefail

RPC_URL="${RPC_URL:-https://rpc.testnet.arc.network}"
CHAIN_ID="${CHAIN_ID:-5042002}"
DEPLOY_JSON="${DEPLOY_JSON:-deployments/darkbox-arc-testnet-5042002.json}"
SEED_BASE_UNITS="${SEED_BASE_UNITS:-1000000}"      # 1 outcome token per book, 6 decimals
TAKER_SPEND_UNITS="${TAKER_SPEND_UNITS:-2000000}"  # enough to buy 1 token at tick 1, 6 decimals
YES_LOWER_TICK="${YES_LOWER_TICK:-1}"
YES_UPPER_TICK="${YES_UPPER_TICK:-2}"
NO_LOWER_TICK="${NO_LOWER_TICK:-1}"
NO_UPPER_TICK="${NO_UPPER_TICK:-2}"

ANVIL_K0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_K1="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: $name" >&2
    exit 2
  fi
}

require DEPLOYER_KEY
require MAKER_KEY
require TAKER_KEY

for key_name in DEPLOYER_KEY MAKER_KEY TAKER_KEY; do
  key="${!key_name}"
  if [ "$key" = "$ANVIL_K0" ] || [ "$key" = "$ANVIL_K1" ]; then
    echo "refusing to use Anvil dev key for $key_name on a reachable network" >&2
    exit 2
  fi
done

if [ ! -f "$DEPLOY_JSON" ]; then
  echo "deployment artifact not found: $DEPLOY_JSON" >&2
  exit 2
fi

actual_chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [ "$actual_chain_id" != "$CHAIN_ID" ]; then
  echo "chain id mismatch: expected $CHAIN_ID, got $actual_chain_id" >&2
  exit 2
fi

j() { jq -r "$1" "$DEPLOY_JSON"; }
SUSDC="$(j '.darkbox.syntheticUSDC')"
ROUTER="$(j '.frontier.router')"
MARKET="$(j '.canonicalMarket.market')"
YES="$(j '.canonicalMarket.yesToken')"
NO="$(j '.canonicalMarket.noToken')"
YESBOOK="$(j '.canonicalMarket.yesBook')"
NOBOOK="$(j '.canonicalMarket.noBook')"
MID="$(j '.canonicalMarket.marketId')"

DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_KEY")"
MAKER="$(cast wallet address --private-key "$MAKER_KEY")"
TAKER="$(cast wallet address --private-key "$TAKER_KEY")"

for addr_name in DEPLOYER MAKER TAKER; do
  addr="${!addr_name}"
  bal="$(cast balance "$addr" --rpc-url "$RPC_URL")"
  if [ "$bal" = "0" ]; then
    echo "$addr_name $addr has zero native gas balance on chain $CHAIN_ID" >&2
    exit 2
  fi
  echo "$addr_name=$addr nativeWei=$bal"
done

for contract_name in SUSDC ROUTER MARKET YES NO YESBOOK NOBOOK; do
  addr="${!contract_name}"
  code="$(cast code "$addr" --rpc-url "$RPC_URL")"
  if [ "$code" = "0x" ]; then
    echo "$contract_name has no code at $addr" >&2
    exit 2
  fi
done

echo "marketId=$MID"
echo "yesBook=$YESBOOK"
echo "noBook=$NOBOOK"

send() {
  local label="$1"; shift
  echo "==> $label" >&2
  cast send "$@" --rpc-url "$RPC_URL" --json | jq -r '.transactionHash // .hash // .'
}

max_uint="$(cast max-uint)"
deadline="$(( $(date +%s) + 3600 ))"

# Demo collateral for maker + taker. SyntheticUSDC has 6 decimals in this stack.
send "mint maker sUSDC" "$SUSDC" 'mint(address,uint256)' "$MAKER" 500000000 --private-key "$DEPLOYER_KEY"
send "mint taker sUSDC" "$SUSDC" 'mint(address,uint256)' "$TAKER" 500000000 --private-key "$DEPLOYER_KEY"

# Deployer owns initial YES/NO from the canonical-market initialLiquidity split.
send "transfer YES inventory to maker" "$YES" 'transfer(address,uint256)(bool)' "$MAKER" "$(( SEED_BASE_UNITS * 10 ))" --private-key "$DEPLOYER_KEY"
send "transfer NO inventory to maker" "$NO" 'transfer(address,uint256)(bool)' "$MAKER" "$(( SEED_BASE_UNITS * 10 ))" --private-key "$DEPLOYER_KEY"

send "maker approve YES book" "$YES" 'approve(address,uint256)(bool)' "$YESBOOK" "$max_uint" --private-key "$MAKER_KEY"
send "maker approve NO book" "$NO" 'approve(address,uint256)(bool)' "$NOBOOK" "$max_uint" --private-key "$MAKER_KEY"
send "taker approve router sUSDC" "$SUSDC" 'approve(address,uint256)(bool)' "$ROUTER" "$max_uint" --private-key "$TAKER_KEY"

send "maker deposits YES ask" "$YESBOOK" 'deposit(int24,int24,uint128)(uint256)' "$YES_LOWER_TICK" "$YES_UPPER_TICK" "$SEED_BASE_UNITS" --private-key "$MAKER_KEY"
send "maker deposits NO ask" "$NOBOOK" 'deposit(int24,int24,uint128)(uint256)' "$NO_LOWER_TICK" "$NO_UPPER_TICK" "$SEED_BASE_UNITS" --private-key "$MAKER_KEY"

send "taker buys YES" "$ROUTER" 'buyExactIn(address,uint256,uint256,address,uint256)(uint256,uint256)' "$YESBOOK" "$TAKER_SPEND_UNITS" 0 "$TAKER" "$deadline" --private-key "$TAKER_KEY"
send "taker buys NO" "$ROUTER" 'buyExactIn(address,uint256,uint256,address,uint256)(uint256,uint256)' "$NOBOOK" "$TAKER_SPEND_UNITS" 0 "$TAKER" "$deadline" --private-key "$TAKER_KEY"

num() { awk '{print $1}'; }
bal() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$RPC_URL" | num; }

echo "==> final demo balances"
echo "maker YES=$(bal "$YES" "$MAKER") NO=$(bal "$NO" "$MAKER") sUSDC=$(bal "$SUSDC" "$MAKER")"
echo "taker YES=$(bal "$YES" "$TAKER") NO=$(bal "$NO" "$TAKER") sUSDC=$(bal "$SUSDC" "$TAKER")"
