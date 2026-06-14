#!/usr/bin/env bash
set -euo pipefail
RPC_URL="${RPC_URL:-https://rpc.testnet.arc.network}"
DEPLOY_JSON="${DEPLOY_JSON:-deployments/darkbox-arc-grant-market-v2-5042002.json}"
LEVELS="${LEVELS:-25}"
LEVEL_SIZE="${LEVEL_SIZE:-10000000}"      # 10 outcome tokens, 6 decimals
BUY_ROUNDS="${BUY_ROUNDS:-15}"
BUY_SPEND="${BUY_SPEND:-25000000}"        # 25 sUSDC, 6 decimals

: "${DEPLOYER_KEY:?missing DEPLOYER_KEY}"
: "${MAKER_KEY:?missing MAKER_KEY}"
: "${TAKER_KEY:?missing TAKER_KEY}"
j() { jq -r "$1" "$DEPLOY_JSON"; }
SUSDC=$(j '.darkbox.syntheticUSDC')
ROUTER=$(j '.frontier.router')
YES=$(j '.canonicalMarket.yesToken')
NO=$(j '.canonicalMarket.noToken')
YESBOOK=$(j '.canonicalMarket.yesBook')
NOBOOK=$(j '.canonicalMarket.noBook')
MARKET=$(j '.canonicalMarket.market')
QUESTION=$(j '.canonicalMarket.question')
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
MAKER=$(cast wallet address --private-key "$MAKER_KEY")
TAKER=$(cast wallet address --private-key "$TAKER_KEY")
max_uint=$(cast max-uint)
deadline=$(( $(date +%s) + 7200 ))
LOG="/tmp/arc-grant-stress-$(date +%Y%m%dT%H%M%SZ).jsonl"
TX_COUNT=0
FAIL_COUNT=0
send() {
  local label="$1"; shift
  local start end rc out hash gas
  start=$(date +%s%3N)
  set +e
  out=$(cast send "$@" --rpc-url "$RPC_URL" --json 2>&1)
  rc=$?
  set -e
  end=$(date +%s%3N)
  if [ "$rc" -eq 0 ]; then
    hash=$(jq -r '.transactionHash // .hash // empty' <<<"$out" 2>/dev/null || true)
    gas=$(jq -r '.gasUsed // empty' <<<"$out" 2>/dev/null || true)
    TX_COUNT=$((TX_COUNT+1))
    jq -cn --arg label "$label" --arg hash "$hash" --argjson ms "$((end-start))" --arg gas "$gas" '{ok:true,label:$label,hash:$hash,ms:$ms,gasUsed:$gas}' >> "$LOG"
    echo "ok $TX_COUNT $label $hash ${end-start}ms"
  else
    FAIL_COUNT=$((FAIL_COUNT+1))
    jq -cn --arg label "$label" --arg err "$out" '{ok:false,label:$label,error:$err}' >> "$LOG"
    echo "FAIL $label" >&2
    echo "$out" | head -8 >&2
  fi
}

echo "question=$QUESTION"
echo "market=$MARKET"
echo "yesBook=$YESBOOK"
echo "noBook=$NOBOOK"
echo "maker=$MAKER taker=$TAKER log=$LOG"

# Large-ish test inventory/cash for maker/taker.
send "mint maker sUSDC" "$SUSDC" 'mint(address,uint256)' "$MAKER" 10000000000 --private-key "$DEPLOYER_KEY"
send "mint taker sUSDC" "$SUSDC" 'mint(address,uint256)' "$TAKER" 10000000000 --private-key "$DEPLOYER_KEY"
send "transfer YES inventory" "$YES" 'transfer(address,uint256)(bool)' "$MAKER" $((LEVELS * LEVEL_SIZE * 2)) --private-key "$DEPLOYER_KEY"
send "transfer NO inventory" "$NO" 'transfer(address,uint256)(bool)' "$MAKER" $((LEVELS * LEVEL_SIZE * 2)) --private-key "$DEPLOYER_KEY"
send "maker approve YES book" "$YES" 'approve(address,uint256)(bool)' "$YESBOOK" "$max_uint" --private-key "$MAKER_KEY"
send "maker approve NO book" "$NO" 'approve(address,uint256)(bool)' "$NOBOOK" "$max_uint" --private-key "$MAKER_KEY"
send "taker approve router sUSDC" "$SUSDC" 'approve(address,uint256)(bool)' "$ROUTER" "$max_uint" --private-key "$TAKER_KEY"

for i in $(seq 1 "$LEVELS"); do
  send "deposit YES tick $i" "$YESBOOK" 'deposit(int24,int24,uint128)(uint256)' "$i" "$((i+1))" "$LEVEL_SIZE" --private-key "$MAKER_KEY"
  send "deposit NO tick $i" "$NOBOOK" 'deposit(int24,int24,uint128)(uint256)' "$i" "$((i+1))" "$LEVEL_SIZE" --private-key "$MAKER_KEY"
done

for i in $(seq 1 "$BUY_ROUNDS"); do
  send "buy YES round $i" "$ROUTER" 'buyExactIn(address,uint256,uint256,address,uint256)(uint256,uint256)' "$YESBOOK" "$BUY_SPEND" 0 "$TAKER" "$deadline" --private-key "$TAKER_KEY"
  send "buy NO round $i" "$ROUTER" 'buyExactIn(address,uint256,uint256,address,uint256)' "$NOBOOK" "$BUY_SPEND" 0 "$TAKER" "$deadline" --private-key "$TAKER_KEY"
done

bal() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$RPC_URL" | awk '{print $1}'; }
echo "summary tx=$TX_COUNT failures=$FAIL_COUNT log=$LOG"
echo "maker YES=$(bal "$YES" "$MAKER") NO=$(bal "$NO" "$MAKER") sUSDC=$(bal "$SUSDC" "$MAKER")"
echo "taker YES=$(bal "$YES" "$TAKER") NO=$(bal "$NO" "$TAKER") sUSDC=$(bal "$SUSDC" "$TAKER")"
