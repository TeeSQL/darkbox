# @darkbox/signer — isolated withdrawal signer

Holds the withdrawal-signer key **off the bridge** and inside the confidential
plane (CVM/TEE). Addresses Fran's #2 RED risk ("the withdrawal signer service is
insecure and needs to move into TEE security land").

> Demo posture: withdrawals are locked until settlement, so this is not on the
> demo hot path. It is built and tested so the secure topology is ready to switch
> on.

## Why it exists / what changed

The signing core (`SigningService`) was inlined in `services/bridge`, meaning the
signer key would live alongside the bridge. The core is now promoted to
`@darkbox/shared` (`signing.ts`) and this service is its isolated host:

- The **key never leaves this service** (injected from a CVM/TEE secret).
- Exactly **one** narrow endpoint, reachable **only by the bridge** (shared
  secret). There is no route that exposes the key or signs arbitrary data.
- Every mandatory check (user EIP-712 sig, owner↔shadow mapping, confirmed
  shadow burn, unused nonce, destination funding, re-issue match) runs before a
  signature is produced.
- **Fails closed**: no key ⇒ won't start; no bridge token ⇒ endpoint 503s; no
  burn/nonce source ⇒ those checks reject.

### Follow-up (bridge owner)

`services/bridge/src/signingService.ts` is now redundant. The bridge's
`withdrawalCoordinator` should call this service over HTTP
(`POST /internal/sign-withdrawal`) instead of constructing a local
`SigningService`, and the inline copy + the signer key env should be removed from
the bridge. Both currently import the same logic via `@darkbox/shared`, so the
behavior is identical.

## Endpoint

`POST /internal/sign-withdrawal` (header `X-Bridge-Token: <secret>`)
Body: `{ command: WithdrawCommandWire, signature: Hex, shadowBurnRef: Hex }`
→ `200 { withdrawalId, payload, signature }` or `422 { error:"rejected", reason }`.

`GET /health` — liveness + signer address (never the key).

## Config (env)

| Var | Notes |
|-----|-------|
| `SIGNER_PRIVATE_KEY` | **required**, from CVM/TEE secret; never logged/committed |
| `SIGNER_BRIDGE_TOKEN` | shared secret the bridge must present |
| `PUBLIC_CHAIN_ID`, `BRIDGE_ADDRESS` | EIP-712 domain (must match the bridge) |
| `GAME_ID` | for owner→shadow derivation |
| `BURN_VERIFY_URL` | internal burn-confirmation endpoint; unset ⇒ rejects |
| `PUBLIC_RPC_URL` | bridge nonce reads; unset ⇒ rejects |
| `AUTH_TTL_SECONDS` | authorization validity window (default 24h) |

## Network isolation

Runs on `hidden_net` only — reachable by `darkbox-bridge`, never from
`public_net` or the internet. First CVM/Phala deploy target (with the
transcriber).

## Run

```bash
pnpm --filter @darkbox/signer typecheck
pnpm --filter @darkbox/signer test
```
