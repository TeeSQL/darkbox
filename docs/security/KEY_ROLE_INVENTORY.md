# DarkBox Key & Role Inventory

Date: 2026-06-13 UTC
Owner: Dan (custody decisions) / Dan's backend-security agent
Status: testnet demo posture. **Not** final-demo / mainnet posture yet.

This is the human-readable key/role inventory required by `04_DAN_TODO.md` P0 #1
and Fran's handover brief. It is the single source of truth for *which key plays
which role, where it lives, what it can do, and how to rotate/pause it.*

> Hard rule: **no real private keys in git.** `.gitignore` now ignores
> `.secrets/`, `secrets/`, `.env*`, and `*.private.json`. Verified clean history
> (the only `*private*` match was the `darkbox-private-88813` deployment-address
> artifact — addresses only, no key material).

## Role → key matrix

| Role | Current address | Target (final demo) | Key location | Powers | Risk |
|------|-----------------|---------------------|--------------|--------|------|
| **Deployer** | `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D` | dedicated deployer EOA (keep) | `.secrets/darkbox-dan-deployer.env` (gitignored); teebox `/home/ubuntu/darkbox/.env`; Ocean `/home/xiko/clawd/secrets/darkbox-dan-deployer.env` | deploy contracts on testnets | testnet-only; never fund on mainnet without a fresh custody decision |
| **Public bridge admin** | `0x7c2A…0E6D` (== deployer) | **Safe multisig** | same as deployer today | `setSigner`, `setAdmin`, `setDepositsPaused`, `setWithdrawalsPaused`, `emergencyWithdraw` | single EOA = single point of failure; move to multisig before real funds |
| **Withdrawal signer** | `0x7c2A…0E6D` (== deployer) | **TEE/CVM-isolated key** inside `darkbox-signer` | same as deployer today (interim) | signs EIP-712 withdrawal authorizations the bridge verifies (`recovered != signer ⇒ revert`) | **HIGH** — leak ⇒ attacker can authorize withdrawals. Must be isolated + rotatable |
| **Hidden-chain coordinator / shadow minter** | TBD (hidden-net only) | dedicated hidden-net key in CVM | not on public boxes | mints/burns shadow USDC on confirmed deposit/withdraw | confined to `hidden_net`; never egress |
| **Demo agent wallets** | e.g. `murmur 0x79c30693…` (+ others) | unchanged (demo only) | `.secrets/agent-keys.private.json` (gitignored) | sign hidden-chain trades for fake/demo daemons | demo liquidity only; no real value |
| **Real user custody** | none held | none (by design) | — | users authenticate via Telegram `initData` and specify a withdrawal destination address inside the Mini App | we are **non-custodial** for users; do not introduce per-user server-held keys |

## Current posture (testnet) vs required posture (final demo)

Today, **deployer == admin == signer == one EOA** (`0x7c2A…0E6D`). That is
acceptable for a Base Sepolia smoke deployment but violates the role-separation
Fran explicitly called out. Before anything with real value:

1. **Admin → multisig.** `bridge.setAdmin(<safe>)`. Removes single-EOA control of
   pause + emergencyWithdraw + signer rotation.
2. **Signer → TEE/CVM.** Generate the withdrawal-signer key *inside* the
   `darkbox-signer` confidential service; never let it touch a public box. Point
   the bridge at it via `bridge.setSigner(<tee-signer>)`. See
   `services/signer` design.
3. **Deployer stays separate** and is never reused as the live signer.

## Rotation & pause runbook (already supported on-chain)

`DarkBoxBridge` exposes the primitives — no contract change needed:

- Rotate the withdrawal signer: `setSigner(newSigner)` (emits `SignerUpdated`).
- Rotate admin / hand off to multisig: `setAdmin(newAdmin)` (emits `AdminUpdated`).
- Pause withdrawals (kill-switch if signer suspected compromised):
  `setWithdrawalsPaused(true)`.
- Pause deposits: `setDepositsPaused(true)`.
- Emergency drain to admin: `emergencyWithdraw(...)` (`onlyAdmin`).

All are `onlyAdmin`, so once admin is a multisig these become multi-party actions.

## Canonical Base Sepolia deployment (testnet)

| Item | Value |
|------|-------|
| Chain / RPC | Base Sepolia `84532` / `https://sepolia.base.org` |
| DarkBoxBridge | `0xe0004c955721b3A994E94CCcA86d91Da4Cf2E6f9` |
| Mock USDC | `0x8C885Cb844362Ed8d161792aEA6745d29d839246` |
| Admin / Signer | `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D` (both, interim) |
| Deployer funding | 0.08 ETH — tx `0x8caccff898902ff25a34404effd17cd74142c370a2e77b7759a9bcee0030919f` |

> ⚠️ Reconciliation note: the local broadcast on `feat/deposits-withdrawals`
> (`broadcast/Deploy.s.sol/84532/run-latest.json`) records a **different, stale**
> deploy — Bridge `0xd87b5440a91e852ee1a9ccd435af3131ce069fd5`, USDC
> `0x45e26ee2b1baa64d774ad51af70367407043473b`. The **canonical** addresses are
> the handover-recorded `0xe000…E6f9` / `0x8C88…9246` ones above. Treat the
> branch broadcast artifact as non-authoritative and re-pin it on the next deploy.

## Acceptance criteria (from TODO #1) — status

- [x] Human-readable key/role inventory exists → this file.
- [x] No real keys in git → `.gitignore` fixed + history verified clean.
- [x] Signer key not in frontend/Mini App/bridge logs → signer is the on-chain
      `signer` address only; private key never logged. (Re-audit once
      `darkbox-signer` exists.)
- [x] Withdrawal authorization can be rotated or paused → `setSigner` +
      `setWithdrawalsPaused` on `DarkBoxBridge`.

Open (tracked, not blocking testnet demo): admin→multisig migration and
signer→TEE migration before real value flows.
