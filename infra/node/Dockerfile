# DarkBox hidden chain node.
#
# Runs a private EVM devnet via anvil (foundry). anvil is used instead of
# geth/reth for the one-hour CVM target because the real Frontier
# GeometricFrontierBook runtime (~25-26 KB) exceeds the EIP-170 24,576 B
# code-size limit, which is a hard-coded consensus constant in geth and reth.
# anvil exposes --code-size-limit, and the hidden chain controls its own genesis.
FROM ghcr.io/foundry-rs/foundry:stable

USER root
RUN mkdir -p /var/lib/darkbox-node \
  && chown -R foundry:foundry /var/lib/darkbox-node

USER foundry

ENV HIDDEN_CHAIN_ID=88813 \
    HIDDEN_RPC_HOST=0.0.0.0 \
    HIDDEN_RPC_PORT=8545 \
    ANVIL_STATE_PATH=/var/lib/darkbox-node/state.json \
    ANVIL_BLOCK_TIME=1 \
    ANVIL_CODE_SIZE_LIMIT=60000 \
    ANVIL_EXTRA_ARGS=""

EXPOSE 8545

# Clear foundry image's shell entrypoint so Docker CMD runs exactly as intended.
ENTRYPOINT []

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD cast block-number --rpc-url "http://127.0.0.1:${HIDDEN_RPC_PORT}" >/dev/null || exit 1

CMD ["sh", "-lc", "anvil --host \"$HIDDEN_RPC_HOST\" --port \"$HIDDEN_RPC_PORT\" --chain-id \"$HIDDEN_CHAIN_ID\" --state \"$ANVIL_STATE_PATH\" --block-time \"$ANVIL_BLOCK_TIME\" --code-size-limit \"$ANVIL_CODE_SIZE_LIMIT\" $ANVIL_EXTRA_ARGS"]
