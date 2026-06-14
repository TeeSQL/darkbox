# Bridge signer rotation — CVM-born key

Provision a fresh **withdrawal-signer** key inside the CVM and register it on the
live Base `DarkBoxBridge`, replacing the unknown placeholder signer.

> Scope: this covers **requirement #1 only** — signing `WithdrawalAuthorization`.
> Deposit-minting (`mintShadow`) and the $5 signup grant use the **coordinator**
> key on the shadow chain's `ShadowBridgeController` — see "Coordinator" below.

## Live facts (Base, chainId 8453, verified)

| Thing | Value |
| --- | --- |
| `DarkBoxBridge` | `0xd48F922348Fba0E4304d8cc5afc3aAd23E26BbD3` |
| current `signer()` | `0xDba775c4384A97D0BF80BA9b0Bc299FCF4F35D14` (placeholder — key not in our infra) |
| `admin()` | `0xf8a025B42B07db05638FE596cce339707ec3cC71` (team-controlled; can call `setSigner`) |
| `usdc()` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle USDC) |

## Procedure — run INSIDE the CVM (signer plane)

The private key must be born in the CVM and never written to git, logs, or chat.

```bash
# 1) Generate the new signer keypair inside the CVM signer container/host.
cast wallet new            # prints Address + Private key — capture privkey to the
                           # CVM secret store ONLY (e.g. docker secret / sealed .env)

# 2) Inject it as the signer service secret (NOT committed):
#    SIGNER_PRIVATE_KEY=0x<new-priv>   ->  darkbox-signer env / secret
#    Restart so the signer service loads it:
docker compose up -d --force-recreate darkbox-signer

# 3) Register the new public address on Base, signed by the admin key.
#    Run wherever the admin key lives (hardware wallet / admin op host),
#    NOT necessarily the signer plane.
NEW_SIGNER=0x<new-address-from-step-1>
cast send 0xd48F922348Fba0E4304d8cc5afc3aAd23E26BbD3 \
  "setSigner(address)" "$NEW_SIGNER" \
  --rpc-url https://mainnet.base.org \
  --account darkbox-admin          # or --ledger / --private-key from the admin secret

# 4) Verify the rotation landed.
cast call 0xd48F922348Fba0E4304d8cc5afc3aAd23E26BbD3 \
  "signer()(address)" --rpc-url https://mainnet.base.org
# -> must equal $NEW_SIGNER
```

Also set the matching env on the signer service so its EIP-712 domain agrees with
the bridge that verifies signatures:

```
PUBLIC_CHAIN_ID=8453
BRIDGE_ADDRESS=0xd48F922348Fba0E4304d8cc5afc3aAd23E26BbD3
GAME_ID=<canonical gameId>
SIGNER_BRIDGE_TOKEN=<shared secret bridge<->signer>
PUBLIC_RPC_URL=https://mainnet.base.org   # nonce checks (fail-closed if unset)
BURN_VERIFY_URL=<internal burn-confirm endpoint>   # fail-closed if unset
```

## Coordinator (requirements #2 and #3) — separate key, shadow chain

`mintShadow()` (deposit credit) and the $5 signup grant are **not** on Base. They
run on the shadow chain's `ShadowBridgeController.coordinator`. Before those work:

1. Locate or deploy `ShadowBridgeController` on the live shadow chain (the in-repo
   88813 artifact is an Anvil dev deploy with **no** bridge contracts — confirm the
   live address).
2. Generate a CVM-born **coordinator** keypair (this one needs gas on the shadow
   chain). Inject as the bridge service secret; `setCoordinator()` it.
3. Wire `POST /api/invites/claim` to call `mintShadow()` for the promo amount,
   keyed on the existing per-Telegram-id idempotency, so the $5 is real sUSDC.
