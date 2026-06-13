#!/usr/bin/env bash
set -euo pipefail

COUNT="${1:-25}"
PUBLIC_PATH="${AGENT_IDENTITIES_FILE:-services/agents/config/agent-identities.json}"
PRIVATE_PATH="${AGENT_KEYS_PRIVATE_FILE:-.secrets/agent-keys.private.json}"

if [ -e "$PRIVATE_PATH" ] && [ "${FORCE:-}" != "1" ]; then
  echo "Refusing to overwrite existing private keys: $PRIVATE_PATH" >&2
  echo "Set FORCE=1 only if you intentionally want to rotate all agent keys." >&2
  exit 1
fi

command -v cast >/dev/null || { echo "cast is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

mkdir -p "$(dirname "$PUBLIC_PATH")" "$(dirname "$PRIVATE_PATH")"
WALLETS_JSON="$(cast wallet new --json -n "$COUNT")"
export WALLETS_JSON COUNT
node <<'NODE' > "$PRIVATE_PATH"
const wallets = JSON.parse(process.env.WALLETS_JSON);
const count = Number(process.env.COUNT ?? wallets.length);
const names = ['murmur','ash','vesper','gloam','rook','nix','omen','sable','hex','wisp','grin','null'];
function agentName(index) {
  const base = names[index % names.length];
  const cycle = Math.floor(index / names.length);
  return cycle === 0 ? base : `${base}-${cycle + 1}`;
}
function shadowAccount(address) {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}
const agents = wallets.slice(0, count).map((wallet, index) => ({
  agentId: agentName(index),
  address: wallet.address,
  shadowAccount: shadowAccount(wallet.address),
  privateKey: wallet.private_key,
}));
process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), agents }, null, 2) + '\n');
NODE
chmod 600 "$PRIVATE_PATH"

jq '{generatedAt, agents: [.agents[] | {agentId, address, shadowAccount}]}' "$PRIVATE_PATH" > "$PUBLIC_PATH"
echo "Wrote public identities: $PUBLIC_PATH"
echo "Wrote private keys: $PRIVATE_PATH (chmod 600, gitignored)"
