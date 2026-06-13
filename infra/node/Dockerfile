# DarkBox hidden chain node.
#
# Runs a private EVM devnet via anvil (foundry). anvil is used instead of
# geth/reth because the real Frontier GeometricFrontierBook runtime (~25-26 KB)
# exceeds the EIP-170 24,576 B code-size limit, which is a hard-coded consensus
# constant in geth and reth and is NOT genesis-configurable. anvil exposes
# `--code-size-limit`, and the hidden chain controls its own genesis.
FROM ghcr.io/foundry-rs/foundry:latest

# Private hidden chain config (RPC bound inside the container; in compose it is
# only reachable on hidden_net and never exposed publicly — TECH_SPEC §3/§6.1).
ENV HIDDEN_CHAIN_ID=88813
ENV CODE_SIZE_LIMIT=60000
ENV BLOCK_TIME=1

EXPOSE 8545
ENTRYPOINT ["sh", "-c", "anvil \
  --host 0.0.0.0 \
  --port 8545 \
  --chain-id ${HIDDEN_CHAIN_ID} \
  --code-size-limit ${CODE_SIZE_LIMIT} \
  --block-time ${BLOCK_TIME} \
  --dump-state /var/lib/darkbox-node/state.json \
  --state /var/lib/darkbox-node/state.json"]
