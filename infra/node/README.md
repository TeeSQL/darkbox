# darkbox-node — hidden EVM chain

Private EVM devnet that hosts the Frontier orderbook + DarkBox prediction-market
contracts. RPC is reachable only on `hidden_net` (never public — TECH_SPEC §3/§6.1).

## Why anvil (not geth/reth)

The real Frontier `GeometricFrontierBook` runtime is ~25–26 KB even at maximum
size optimization (`optimizer-runs=1` → 25,228 B), exceeding the EIP-170
24,576 B contract-code limit. That limit is a hard-coded consensus constant in
go-ethereum and reth (revm) and is **not** genesis-configurable, so neither can
host the real Frontier book. anvil exposes `--code-size-limit`; since the hidden
chain owns its genesis, anvil (foundry's local EVM node) is the fastest reliable
path. Chain config: dedicated chain-id `88813`, private host binding, interval
mining, on-disk state persistence.

## Run locally (no Docker)

Deploy + smoke-test the full Frontier + DarkBox stack on the persistent hidden
chain:

```sh
bash infra/node/run-hidden-chain-e2e.sh
```

This starts anvil (chain-id 88813, code-size-limit 60000, state persisted to
`infra/node/data/hidden-chain-state.json`), deploys via
`packages/contracts/script/DeployDarkBox.s.sol`, writes addresses to
`packages/contracts/deployments/darkbox-private-88813.json`, and runs a 9-step
live check (deploy → books → split → maker ask → taker buy via router →
resolve → redeem).

## Run via Docker

`docker compose up darkbox-node` builds the foundry image and runs anvil with the
same config, persisting state to the `node_data` volume.
