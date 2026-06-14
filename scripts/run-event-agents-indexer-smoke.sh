#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Event-driven Python agents → indexer RECONCILIATION smoke (local).
#
# Complements Dan's scripts/run-event-agent-testnet.sh (which deploys Frontier +
# DarkBox and runs the decision loop). This one closes the missing adapter loop:
# it boots a throwaway Postgres + the real indexer, then drives the Python
# `event_agents.runner` with --submit-url so each deterministic decision is
# reconciled through /internal/v0/agent-turns, and asserts the indexer state
# (orders, billboards, admin-queue proposals) plus the production-safety
# negatives:
#
#   A. ash  (market_created)  : make_order + allowed billboard + objective proposal
#   B. vesper (same candidate): DUPLICATE proposal -> dropped by the indexer
#   C. direct POST           : hidden-state-leaking billboard -> dropped
#   D. invariants            : exactly 1 queued proposal (status 'proposed');
#                              no proposal ever becomes an on-chain markets row.
#
# Requires: docker, node, pnpm, python3, curl, jq. Zero secrets. Never touches prod.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_CONTAINER="darkbox-eventagents-smoke-pg"
PG_PORT="${PG_PORT:-5545}"
INDEXER_PORT="${INDEXER_PORT:-8089}"
RUN_ID="evt-smoke-$$"
BASE="http://127.0.0.1:${INDEXER_PORT}"
DB_URL="postgres://darkbox:darkbox_dev_only@127.0.0.1:${PG_PORT}/darkbox"
WORK="$(mktemp -d)"

INDEXER_PID=""
cleanup() {
  [[ -n "$INDEXER_PID" ]] && kill "$INDEXER_PID" 2>/dev/null || true
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "❌ FAIL: $*" >&2; exit 1; }
pass() { echo "✅ $*"; }

QUESTION="Will at least 10 projects mention Base?"

# ── fixtures (self-contained identities/bindings/policies) ───────────────────
mkdir -p "$WORK/policies"
cat > "$WORK/identities.json" <<JSON
{"agents":[
  {"agentId":"ash","address":"0x00000000000000000000000000000000000000a5","shadowAccount":"0x00000000000000000000000000000000000000a5"},
  {"agentId":"vesper","address":"0x00000000000000000000000000000000000000e5","shadowAccount":"0x00000000000000000000000000000000000000e5"}
]}
JSON
cat > "$WORK/bindings.json" <<JSON
{"schema":"darkbox.owner-daemon-bindings.v1","bindings":[
  {"gameId":"0x01","owner":"0xowner","agentId":"ash","daemonAddress":"0x00000000000000000000000000000000000000a5","shadowAccount":"0x00000000000000000000000000000000000000a5","status":"registered"},
  {"gameId":"0x01","owner":"0xowner","agentId":"vesper","daemonAddress":"0x00000000000000000000000000000000000000e5","shadowAccount":"0x00000000000000000000000000000000000000e5","status":"registered"}
]}
JSON
PROPOSAL_CANDIDATE=$(jq -n --arg q "$QUESTION" '[{question:$q,description:"Sponsor adoption.",outcomes:["YES","NO"],resolveBy:"2026-09-01T00:00:00Z",resolutionSource:"ETHGlobal public submissions",rationale:"public edge"}]')
for AGENT in ash vesper; do
  jq -n --argjson cands "$PROPOSAL_CANDIDATE" '{enabled:true,fairValues:{m1:0.55},billboardStyle:"liquidity ad",proposalCandidates:$cands}' > "$WORK/policies/$AGENT.json"
done
# event + observation: market just created, empty book (forces a quote make_order), future now.
cat > "$WORK/event.json" <<JSON
{"eventId":"$RUN_ID-e1","type":"market_created","at":"2026-06-14T00:00:00Z","marketId":"m1"}
JSON
cat > "$WORK/obs.json" <<JSON
{"now":"2026-06-14T00:00:00Z","markets":[{"marketId":"m1","question":"Will DarkBox be a finalist?","status":"open","bestBid":"0.45","bestAsk":"0.55","lastPrice":"0.50"}],"orders":[],"portfolio":{"cash":"100","equity":"100","positions":[]}}
JSON

# ── infra ────────────────────────────────────────────────────────────────────
echo "==> starting Postgres ($PG_CONTAINER) on :${PG_PORT}"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" -e POSTGRES_DB=darkbox -e POSTGRES_USER=darkbox -e POSTGRES_PASSWORD=darkbox_dev_only -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG_CONTAINER" pg_isready -U darkbox >/dev/null 2>&1 && break; sleep 0.5; done

echo "==> starting indexer on :${INDEXER_PORT} (auto-migrate)"
( cd "$ROOT/services/indexer" && PORT="$INDEXER_PORT" DATABASE_URL="$DB_URL" POLL_INTERVAL_MS=60000 node --import tsx src/index.ts ) >"$WORK/indexer.log" 2>&1 &
INDEXER_PID=$!
for _ in $(seq 1 60); do curl -fsS "${BASE}/internal/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "${BASE}/internal/health" >/dev/null 2>&1 || { cat "$WORK/indexer.log"; fail "indexer not healthy"; }

run_agent() { # $1=agent
  python3 -m services.agents.event_agents.runner \
    --event "$WORK/event.json" --observation "$WORK/obs.json" \
    --identities "$WORK/identities.json" --bindings "$WORK/bindings.json" \
    --policy-dir "$WORK/policies" --agent "$1" \
    --state-file "$WORK/state-$1.json" --submit-url "$BASE" --run-id "$RUN_ID-$1" --out -
}

# ── A. ash: make_order + billboard + objective proposal ──────────────────────
echo "==> A. ash decision via Python runner → indexer"
ASH=$(run_agent ash)
echo "    decision: $(echo "$ASH" | jq -c '{ok,actions:[.tradeActions[].type],bb:.billboardPost,prop:(.marketProposal.question // null)}')"
echo "    submit:   $(echo "$ASH" | jq -c '.submitResult.body // .submitResult')"
[[ "$(echo "$ASH" | jq -r '.submitResult.body.proposalCreated')" == "true" ]] || fail "ash proposal should reconcile into the queue"
[[ "$(echo "$ASH" | jq -r '.submitResult.body.billboardCreated')" == "true" ]] || fail "ash billboard should reconcile"
[[ "$(echo "$ASH" | jq -r '.submitResult.body.ordersCreated')" -ge 1 ]] || fail "ash make_order should reconcile into an order row"
pass "Python decision reconciled (order + billboard + proposal)"

# ── B. vesper: same proposal candidate → indexer drops duplicate ─────────────
echo "==> B. vesper duplicate proposal → indexer dedup"
VESP=$(run_agent vesper)
echo "    submit:   $(echo "$VESP" | jq -c '.submitResult.body')"
[[ "$(echo "$VESP" | jq -r '.submitResult.body.proposalCreated')" == "false" ]] || fail "duplicate proposal must NOT be created"
[[ "$(echo "$VESP" | jq -r '.submitResult.body.proposalRejected')" == "duplicate" ]] || fail "indexer must reject the duplicate"
pass "duplicate proposal dropped at the indexer boundary"

# ── C. direct POST: hidden-state-leaking billboard → dropped ─────────────────
echo "==> C. leaky billboard via direct POST → dropped"
LEAK=$(curl -fsS -X POST "${BASE}/internal/v0/agent-turns" -H 'content-type: application/json' -d "$(jq -n --arg run "$RUN_ID-leak" '{runId:$run,agentId:"grin",turn:0,output:{tradeActions:[],billboardPost:{message:"filled via shadow_account 0x1234567890abcdef1234567890abcdef12345678"},marketProposal:null}}')")
echo "    submit:   $LEAK"
[[ "$(echo "$LEAK" | jq -r '.billboardCreated')" == "false" ]] || fail "leaky billboard must NOT be created"
echo "$LEAK" | jq -r '.billboardRejected' | grep -q '^hidden_state_leak' || fail "leaky billboard must be rejected"
pass "hidden-state-leaking billboard dropped"

# ── D. invariants ────────────────────────────────────────────────────────────
echo "==> D. verifying reconciled indexer state"
COUNT=$(curl -fsS "${BASE}/internal/market-proposals?status=proposed" | jq 'length')
[[ "$COUNT" == "1" ]] || fail "expected exactly 1 queued proposal, got $COUNT"
pass "exactly one proposal in the admin queue (status=proposed)"
MKT_DUP=$(curl -fsS "${BASE}/internal/markets" | jq --arg q "$QUESTION" '[.[] | select(.question==$q)] | length')
[[ "$MKT_DUP" == "0" ]] || fail "a proposal must never auto-create an on-chain market"
pass "no proposal became an on-chain market (admin-queue-only holds)"

echo ""
echo "🎉 ALL ASSERTIONS PASSED — event-driven Python agents reconcile into the indexer with policy enforced."
