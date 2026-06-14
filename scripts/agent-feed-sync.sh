#!/usr/bin/env bash
set -euo pipefail

# Default output now belongs to the standalone admin app, not the player Mini App.
OUTPUT_PATH="${OUTPUT_PATH:-/home/xiko/darkbox/apps/admin-miniapp/dist/agent-feed.json}"
REMOTE_WEBROOT="${REMOTE_WEBROOT:-}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

ssh teebox 'cd /home/ubuntu/darkbox
LOG_DIR="logs/agents"
SERVICE_LOG_DIR="services/agents/logs/agents"
if [ -f "$SERVICE_LOG_DIR/current-run-id.txt" ]; then
  LOG_DIR="$SERVICE_LOG_DIR"
elif [ ! -d "$LOG_DIR" ] || ! ls "$LOG_DIR"/*.jsonl >/dev/null 2>&1; then
  LOG_DIR="$SERVICE_LOG_DIR"
fi
RUN_ID=$(cat "$LOG_DIR/current-run-id.txt" 2>/dev/null || true)
if [ -z "$RUN_ID" ]; then
  RUN_ID=$(basename "$(ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -1)" .jsonl 2>/dev/null || true)
fi
RUNNER_UP=false
if ps -eo command | grep -q "[s]rc/noise.ts --strategy venice"; then RUNNER_UP=true; fi
if [ -z "$RUN_ID" ] || [ ! -f "$LOG_DIR/$RUN_ID.jsonl" ]; then
  jq -n --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg runId "$RUN_ID" --argjson runnerUp "$RUNNER_UP" \
    "{generatedAt:\$generatedAt, runId:\$runId, runnerUp:\$runnerUp, model:\"unknown\", totals:{events:0, ok:0, errors:0, actions:{}}, latest:[]}"
  exit 0
fi
MODEL=$(jq -r "select(.type==\"run_started\") | .strategy" "$LOG_DIR/$RUN_ID.jsonl" 2>/dev/null | tail -1)
tail -n 240 "$LOG_DIR/$RUN_ID.jsonl" | jq -s \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg runId "$RUN_ID" \
  --arg model "${MODEL:-unknown}" \
  --argjson runnerUp "$RUNNER_UP" \
  '\''
  def turns: map(select(.type == "turn" or .type == "turn_error"));
  def action_counts:
    [turns[] | select(.type == "turn") | .output.tradeActions[]?.type]
    | reduce .[] as $a ({}; .[$a] = (.[$a] // 0) + 1);
  {
    generatedAt: $generatedAt,
    runId: $runId,
    runnerUp: $runnerUp,
    model: $model,
    totals: {
      events: (turns | length),
      ok: ([turns[] | select(.ok == true)] | length),
      errors: ([turns[] | select(.ok != true)] | length),
      actions: action_counts
    },
    latest: (turns | .[-24:] | map({
      at,
      turn,
      agentId: (.agentId // "unknown-agent"),
      ok: (.ok == true),
      actionTypes: (if .type == "turn" then [.output.tradeActions[]?.type] else ["error"] end),
      billboard: (if .type == "turn" then (.output.billboardPost.message // null) else (.error // "turn error") end)
    }))
  }
  '\''
' > "$TMP"

python3 -m json.tool "$TMP" >/dev/null
mkdir -p "$(dirname "$OUTPUT_PATH")"
install -m 0644 "$TMP" "$OUTPUT_PATH"

if [ -n "$REMOTE_WEBROOT" ]; then
  remote_host="${REMOTE_WEBROOT%%:*}"
  remote_dir="${REMOTE_WEBROOT#*:}"
  scp "$TMP" "$REMOTE_WEBROOT/agent-feed.json.tmp"
  ssh "$remote_host" "mv '$remote_dir/agent-feed.json.tmp' '$remote_dir/agent-feed.json' && chmod 644 '$remote_dir/agent-feed.json'"
fi
