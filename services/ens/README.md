# darkbox-ens

ENS identity + commitment record service. Holds each agent's `darkbox:*` text
records (pre-game commitments, then post-reveal records) and the name→owner
mapping.

## API

- `GET /health` (alias `GET /ens/health`)
- `POST /ens/register {name, owner, texts}` — register a name with the full
  pre-game commitment record set (validated)
- `GET /ens/names` / `GET /ens/names/:name`
- `POST /ens/names/:name/records {texts}` — merge post-reveal records

## Offchain resolver (ERC-3668 / CCIP-Read)

`<agent>.darkbox.eth` resolves **offchain** — records stay in this service and
cost zero gas per agent. An `OffchainResolver` contract
(`packages/contracts/src/ens/OffchainResolver.sol`) is set as the resolver for
`darkbox.eth`; it reverts lookups with `OffchainLookup`, pointing clients at
this service's gateway:

- `GET /r/{sender}/{data}.json` — CCIP-Read entrypoint (the resolver's gateway
  URL template). Decodes the wrapped `text(node,key)` / `addr(node)` call,
  answers it from the registry, and returns an EIP-191 `0x1900`-signed payload
  that `OffchainResolver.resolveWithProof` verifies.
- `POST /r {sender, data}` — same, POST form.
- `GET /ens/gateway` — reports whether signing is enabled and the signer address
  to configure on-chain.

### Config

- `ENS_GATEWAY_PRIVATE_KEY` — 0x-prefixed signer key. Must match a signer
  trusted by the `OffchainResolver`. If unset, `/r/*` returns `501` (record
  CRUD still works). Keep this key in the CVM/secret store.
- `ENS_GATEWAY_TTL` — seconds a signed answer stays valid (default `300`).

### On-chain runbook (one-time, with the `darkbox.eth` owner key)

1. Generate the gateway signer key; set `ENS_GATEWAY_PRIVATE_KEY` on this
   service. Read the address from `GET /ens/gateway`.
2. Deploy the resolver:
   ```
   ENS_GATEWAY_URL=https://<ens-host>/r/{sender}/{data}.json \
   ENS_GATEWAY_SIGNER=<address from /ens/gateway> \
   DEPLOYER_KEY=<darkbox.eth owner key> \
   forge script script/DeployOffchainResolver.s.sol --rpc-url <mainnet> --broadcast
   ```
3. In the ENS app (or `ENSRegistry.setResolver`), set **`darkbox.eth`'s
   resolver** to the deployed `OffchainResolver` address. ← the single L1 tx
   that wires the name to this service.
4. Verify: `dig`/`viem getEnsText` for `alice.darkbox.eth` `darkbox:gameId`
   should return the registry value.

No per-agent on-chain transactions are needed after this — registering a name
via `POST /ens/register` makes it immediately resolvable.

See ../../docs/TECH_SPEC.md §11 for the ENS integration contract.
