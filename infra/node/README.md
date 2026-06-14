# darkbox-node

Hidden EVM chain (Reth/Geth, private devnet) hosting the shadow accounts,
owner mapping, Frontier/orderbook contracts, and bridge-controller contracts.
JSON-RPC is exposed only on the internal Docker network.

## Status: infra-bound (not buildable in-process)

Unlike the other services, this is a real chain plus on-chain Solidity
contracts. It cannot be stubbed into a Node service. What it requires:

1. A Reth or Geth private devnet image with a funded genesis.
2. The shadow-asset, owner-mapping, orderbook, and bridge-controller contracts
   deployed to it.
3. An event ingester in `darkbox-indexer` that replaces the in-process engine
   as the source of truth, indexing on-chain fills/positions instead.

Today the canonical execution lives in the indexer's deterministic
`MarketEngine` (event-sourced, replayable). That engine is the exact semantics
the on-chain contracts must implement; when the chain exists, the indexer
switches from "own the engine" to "index the chain", and the engine becomes the
reference spec / local-dev simulator.

See ../../docs/TECH_SPEC.md §8.x (hidden node) for the contract.
