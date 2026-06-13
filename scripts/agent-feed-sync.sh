#!/usr/bin/env bash
set -euo pipefail

REMOTE_WEBROOT="${REMOTE_WEBROOT:-fran@204.168.190.248:/var/www/repo.box/subdomains/darkbox-mic}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

ssh teebox 'cd /home/ubuntu/darkbox
RUN_ID=$(cat logs/agents/current-run-id.txt 2>/dev/null || true)
RUNNER_UP=false
if tmux has-session -t darkbox-agent-noise 2>/dev/null; then RUNNER_UP=true; fi
if [ -z "$RUN_ID" ] || [ ! -f "logs/agents/$RUN_ID.jsonl" ]; then
  jq -n --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg runId "$RUN_ID" --argjson runnerUp "$RUNNER_UP" \
    "{generatedAt:\$generatedAt, runId:\$runId, runnerUp:\$runnerUp, model:\"unknown\", totals:{events:0, ok:0, errors:0, actions:{}}, latest:[]}"
  exit 0
fi
MODEL=$(jq -r "select(.type==\"run_started\") | .strategy" "logs/agents/$RUN_ID.jsonl" 2>/dev/null | tail -1)
tail -n 240 "logs/agents/$RUN_ID.jsonl" | jq -s \
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
scp "$TMP" "$REMOTE_WEBROOT/agent-feed.json.tmp"
ssh "${REMOTE_WEBROOT%%:*}" "mv /var/www/repo.box/subdomains/darkbox-mic/agent-feed.json.tmp /var/www/repo.box/subdomains/darkbox-mic/agent-feed.json && chmod 644 /var/www/repo.box/subdomains/darkbox-mic/agent-feed.json"
