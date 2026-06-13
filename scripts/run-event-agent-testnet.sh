#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-18545}"
RPC="http://127.0.0.1:${PORT}"
CHAIN_ID="${CHAIN_ID:-88813}"
RUN_ID="${RUN_ID:-event-agents-$(date -u +%Y%m%dT%H%M%SZ)}"
LOG_DIR="${LOG_DIR:-/tmp/darkbox-event-agent-testnet/$RUN_ID}"
AGENTS_CSV="${AGENTS:-murmur,ash,vesper,gloam}"
RUN_SECONDS="${RUN_SECONDS:-0}" # 0 = run until stopped
mkdir -p "$LOG_DIR"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_DIR/harness.log"; }
json_get() { python3 -c "import json; d=json.load(open('$1')); print($2)"; }
cleanup() {
  if [ -n "${ANVIL_PID:-}" ]; then
    log "stopping anvil pid=$ANVIL_PID"
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if pgrep -f "anvil .*--port $PORT" >/dev/null 2>&1; then
  log "killing stale anvil on port $PORT"
  pkill -f "anvil .*--port $PORT" || true
  sleep 1
fi

log "starting hidden-chain anvil port=$PORT chain=$CHAIN_ID"
anvil --host 127.0.0.1 --port "$PORT" --chain-id "$CHAIN_ID" --code-size-limit 60000 --block-time 1 --silent >"$LOG_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
cast chain-id --rpc-url "$RPC" | tee "$LOG_DIR/chain-id.txt" >/dev/null
log "anvil ready chain_id=$(cat "$LOG_DIR/chain-id.txt") pid=$ANVIL_PID"

DEPLOY_REL="deployments/${RUN_ID}.json"
DEPLOY_OUT="$LOG_DIR/darkbox-deploy.json"
log "deploying Frontier + DarkBox stack"
(
  cd packages/contracts
  DEPLOY_OUT="$DEPLOY_REL" forge script script/DeployDarkBox.s.sol:DeployDarkBox --rpc-url "$RPC" --broadcast --slow --non-interactive
) >"$LOG_DIR/deploy.log" 2>&1 || { log "deploy failed; tail follows"; tail -80 "$LOG_DIR/deploy.log"; exit 1; }
cp "packages/contracts/$DEPLOY_REL" "$DEPLOY_OUT"
log "deploy complete: $DEPLOY_OUT"

MARKET_ID="$(json_get "$DEPLOY_OUT" "d['canonicalMarket']['marketId']")"
MARKET="$(json_get "$DEPLOY_OUT" "d['canonicalMarket']['market']")"
YES_BOOK="$(json_get "$DEPLOY_OUT" "d['canonicalMarket']['yesBook']")"
NO_BOOK="$(json_get "$DEPLOY_OUT" "d['canonicalMarket']['noBook']")"
log "market=$MARKET market_id=$MARKET_ID yes_book=$YES_BOOK no_book=$NO_BOOK"

BINDINGS="$LOG_DIR/owner-daemon-bindings.json"
OWNER="0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
GAME_ID="0x0000000000000000000000000000000000000000000000000000000000000001"
IFS=',' read -r -a AGENTS <<< "$AGENTS_CSV"
AGENTS_JSON="$(printf '%s\n' "${AGENTS[@]}" | python3 -c 'import json,sys; print(json.dumps([x.strip() for x in sys.stdin if x.strip()]))')"
AGENTS_JSON="$AGENTS_JSON" OWNER="$OWNER" GAME_ID="$GAME_ID" BINDINGS="$BINDINGS" python3 <<'PYBIND' >"$LOG_DIR/bindings.log"
import json, os
from datetime import datetime, timezone
with open('services/agents/config/agent-identities.json') as f:
    identities = {a['agentId']: a for a in json.load(f)['agents']}
agents = json.loads(os.environ['AGENTS_JSON'])
now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
rows = []
for agent in agents:
    identity = identities[agent]
    rows.append({
        'gameId': os.environ['GAME_ID'],
        'owner': os.environ['OWNER'],
        'agentId': agent,
        'daemonAddress': identity['address'],
        'shadowAccount': identity['shadowAccount'],
        'status': 'registered',
        'createdAt': now,
        'updatedAt': now,
    })
out = {'schema': 'darkbox.owner-daemon-bindings.v1', 'updatedAt': now, 'bindings': rows}
with open(os.environ['BINDINGS'], 'w') as f:
    json.dump(out, f, indent=2)
    f.write('\n')
print(json.dumps(out, indent=2))
PYBIND
log "registered owner-daemon bindings for: $AGENTS_CSV"

START=$(date +%s)
TURN=0
ACTIONS_JSONL="$LOG_DIR/actions.jsonl"
log "event loop started; actions=$ACTIONS_JSONL"
while true; do
  TURN=$((TURN + 1))
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  EVENT="$LOG_DIR/event-$TURN.json"
  OBS="$LOG_DIR/observation-$TURN.json"
  # Alternate between cheap rival asks, stale own orders, and inventory take-profit scenarios.
  case $((TURN % 3)) in
    1)
      BEST_BID="0.40"; BEST_ASK="0.50"; RIVAL_PRICE="0.34"; POSITION='[]';;
    2)
      BEST_BID="0.52"; BEST_ASK="0.62"; RIVAL_PRICE="0.44"; POSITION='[{"marketId":"'"$MARKET_ID"'","outcome":"YES","size":"6","avgEntry":"0.35"}]';;
    *)
      BEST_BID="0.46"; BEST_ASK="0.56"; RIVAL_PRICE="0.70"; POSITION='[]';;
  esac
  cat > "$EVENT" <<JSON
{"eventId":"$RUN_ID-$TURN","type":"orderbook_changed","at":"$NOW","marketId":"$MARKET_ID","payload":{"source":"local-hidden-chain-harness","frontierMarket":"$MARKET","yesBook":"$YES_BOOK","noBook":"$NO_BOOK"}}
JSON
  cat > "$OBS" <<JSON
{"markets":[{"marketId":"$MARKET_ID","question":"Will DarkBox be selected as a finalist?","status":"open","bestBid":"$BEST_BID","bestAsk":"$BEST_ASK","lastPrice":"0.50"}],"orders":[{"orderId":"rival-$TURN","marketId":"$MARKET_ID","agentId":"rival","side":"sell","outcome":"YES","price":"$RIVAL_PRICE","size":"5","remainingSize":"5"}],"portfolio":{"cash":"100","equity":"100","positions":$POSITION}}
JSON
  for AGENT in "${AGENTS[@]}"; do
    python3 -m services.agents.event_agents.runner \
      --event "$EVENT" \
      --observation "$OBS" \
      --bindings "$BINDINGS" \
      --agent "$AGENT" \
      --out "$ACTIONS_JSONL"
  done
  SUMMARY=$(tail -n "${#AGENTS[@]}" "$ACTIONS_JSONL" | python3 -c 'import json,sys; rows=[json.loads(x) for x in sys.stdin if x.strip()]; print("; ".join(f"{r[\"agentId\"]}:{r[\"ok\"]}:{\",\".join(a[\"type\"] for a in r[\"tradeActions\"])}" for r in rows))')
  log "turn=$TURN $SUMMARY"
  if [ "$RUN_SECONDS" != "0" ] && [ $(( $(date +%s) - START )) -ge "$RUN_SECONDS" ]; then
    log "run_seconds reached; exiting"
    break
  fi
  sleep "${EVENT_INTERVAL_SECONDS:-2}"
done
