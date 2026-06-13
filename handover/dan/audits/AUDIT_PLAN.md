# DarkBox Audit Plan

Last reviewed: 2026-06-13 UTC  
Repo path: `/home/xiko/darkbox`  
Audience: Dan + Dan's agent

## 1. Audit objective

Audit the DarkBox MVP trading/bridge system with focus on:
- public escrow safety
- shadow ledger correctness
- withdrawal authorization integrity
- bridge/operator trust boundaries
- hidden/public accounting reconciliation
- Frontier/orderbook integration risks
- operational security around deploy/signer/coordinator keys

This repo is still partially scaffolded, so the audit must cover both:
- code that exists now
- critical missing pieces that can invalidate security assumptions later

## 2. Current contract scope present in repo

### In-scope Solidity files
- `packages/contracts/src/DarkBoxBridge.sol`
- `packages/contracts/src/ShadowBridgeController.sol`
- `packages/contracts/src/interfaces/IDarkBoxBridge.sol`
- `packages/contracts/src/interfaces/IShadowBridgeController.sol`
- `packages/contracts/src/lib/ECDSA.sol`
- `packages/contracts/src/mocks/MockERC20.sol` (test-only, low priority)
- `packages/contracts/script/Deploy.s.sol` (deployment correctness review)

### In-scope tests/specs for audit context
- `packages/contracts/test/DarkBoxBridge.t.sol`
- `packages/contracts/test/ShadowBridgeController.t.sol`
- `packages/contracts/test/EIP712Parity.t.sol`
- `docs/DEPOSITS_WITHDRAWALS_SPEC.md`
- `docs/TECH_SPEC.md`
- `docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md`

## 3. Systems that must be audited but are missing/incomplete

These are **required audit surfaces**, but the implementation is not here yet or is only placeholder-level:
- `services/bridge/` real coordinator/watcher/signing logic
- hidden node / Frontier deployment topology
- market factory / market contracts / orderbook integration code
- signing service for withdrawal authorizations
- ENS/reveal services if they write commitment or reveal records
- public/private API auth boundaries once implemented
- Docker/CVM secret injection and network isolation

## 4. Frontier / orderbook scope

This is a major blocker.

Fran explicitly asked to audit the Frontier/orderbook integration too, but in the inspected repo snapshot:
- no Frontier contracts are vendored
- no market/orderbook wrapper contracts exist here
- no actual integration adapter contracts exist here
- no execution or settlement hooks are present here

### Therefore
Frontier/orderbook audit scope is currently **spec-level only** and cannot be completed as a code audit until Dan's agent supplies:
- exact Frontier commit/version
- any local patches/forks
- integration contracts
- order routing / settlement / collateral accounting glue code
- liquidation/cancellation rules if any

## 5. Exact audit routine

### Phase A — deterministic prep
1. Read the specs:
   - `docs/TECH_SPEC.md`
   - `docs/DEPOSITS_WITHDRAWALS_SPEC.md`
   - `docs/MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md`
2. Build a threat model:
   - custody loss
   - unauthorized withdrawal
   - duplicate mint
   - withdrawal replay
   - hidden/public ledger divergence
   - lock-balance bypass
   - signer/admin compromise
   - bridge service compromise
   - hidden chain coordinator compromise
3. Build current contract/test inventory.

### Phase B — local contract validation
Run:
```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/contracts test
```
Observed result in this pass:
- **38 tests passed, 0 failed** after Ocean patches (zero signer guard, exact token receipt guard, and explicit winner-withdrawal-over-deposit regression test).

If Foundry is available, also run:
```bash
cd /home/xiko/darkbox/packages/contracts
forge build
forge test -vvvv
```

### Phase C — manual code review checklist
For `DarkBoxBridge.sol`:
- constructor parameter validation
- EIP-712 domain separation correctness
- digest field coverage and ordering
- signature malleability / recovery correctness via local ECDSA lib
- replay protection (`usedNonces`)
- wrong-destination protection
- pause behavior
- emergency withdrawal power review
- ERC20 safe transfer assumptions
- total deposited / total withdrawn accounting sanity
- withdrawal authorization invariant: public bridge should accept withdrawals that exceed original deposit when backed by hidden-ledger winnings and a valid TEE/signer authorization

For `ShadowBridgeController.sol`:
- owner ↔ shadow mapping immutability
- idempotent minting by `depositOpId`
- idempotent burn by `withdrawalId`
- withdrawable balance logic (`balance - locked`)
- lock bypass attempts
- mapping mismatch protection
- coordinator privilege breadth

For deployment scripts:
- dangerous defaults
- accidental reuse of deployer as admin/coordinator/signer
- chain mismatch mistakes
- mock-token vs real-token misuse

### Phase D — spec/implementation gap analysis
Compare code against specs for:
- Base + Arc support
- promo credit flow
- invite withdrawal lock until Sunday 17:00
- withdrawals disabled during live play
- registration freeze
- emergency recovery path
- internal/public API boundaries
- reveal accounting completeness

### Phase E — offchain/system audit once code exists
When Dan's agent lands real code, audit:
- deposit watcher idempotency
- shadow mint reconciliation
- withdrawal command signing flow
- shadow burn confirmation gating
- signer service auth and key isolation
- internal API authN/authZ
- hidden chain RPC exposure
- Docker network isolation
- TEE/CVM secret handling

### Phase F — fix loop
1. Write findings with severity and exploitability.
2. Patch issues.
3. Re-run unit tests.
4. Add regression tests for every real bug.
5. Re-audit only the changed and dependent surfaces.
6. Update PDF report.

## 6. PDF output path

Final audit reports should be stored in:
- `handover/dan/audits/pdf/`

Recommended filenames:
- `handover/dan/audits/pdf/darkbox-contracts-audit-v1.pdf`
- `handover/dan/audits/pdf/darkbox-frontier-integration-audit-v1.pdf`
- `handover/dan/audits/pdf/darkbox-system-security-audit-v1.pdf`

Current status:
- this directory/report PDF does **not** exist yet in the repo snapshot I reviewed.
- only this plan markdown has been produced in this pass.

## 7. Suggested finding categories

Use at least these classes:
- Critical — direct fund loss / arbitrary withdrawal / permanent lockup
- High — realistic severe trust or accounting failure
- Medium — meaningful correctness or operational risk
- Low — edge-case behavior / maintainability / admin footgun
- Informational — architecture notes, centralization, missing monitoring, TODOs

## 8. Current likely findings before full audit write-up

Based on the present snapshot, these are the likely issue buckets Dan should expect:

### Likely High / Medium
- Admin/signer centralization risk
- Offchain signer service is the real security boundary, but not implemented/audited here
- Hidden-chain coordinator is fully trusted and can arbitrarily mint/burn/lock
- No onchain proof that the TEE/signer authorization exactly matches hidden-ledger resolved value; this is expected for MVP privacy but makes signer/TEE correctness the real security boundary
- Promo invite withdrawal lock is specified but not enforced in current Solidity
- “Withdrawals disabled during live play” exists as an operational rule, not automated rule
- Base deployment config inconsistency suggests operational drift risk

### Likely Informational
- Test coverage is solid for current narrow scope
- EIP-712 parity tests reduce client/contract mismatch risk
- Contract scope is intentionally MVP/simple, but strongly centralized

## 9. Current blockers

These blockers prevent a complete Fran-requested audit right now:
- No Frontier/orderbook integration code in repo snapshot
- No actual bridge service implementation to audit
- No hidden node config/deployment implementation to audit
- No signing service implementation to audit
- No Arc deployment config/artifact
- PDF report generation pending in this run

## 10. Recommended immediate next audit tasks for Dan's agent

1. Vendor or pin the exact Frontier contracts/commit.
2. Add all integration contracts/wrappers to repo.
3. Implement `services/bridge` real logic.
4. Implement signer service with isolated key handling.
5. Add Base Sepolia deployment and stage end-to-end deposit/withdraw smoke tests.
6. Generate first markdown findings set.
7. Render findings into PDF under `handover/dan/audits/pdf/`.
8. Patch findings and re-run tests.

## 11. Minimal command checklist for the next auditor

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/contracts test

cd /home/xiko/darkbox/packages/contracts
forge build
forge test -vvvv
```

Then review:
- `packages/contracts/src/*.sol`
- `packages/contracts/test/*.sol`
- `docs/*.md`
- deployed artifact under `packages/contracts/broadcast/Deploy.s.sol/8453/run-latest.json`

## 12. Deliverables expected after full audit loop

At minimum Dan should expect:
- Markdown findings doc
- PDF contract audit report
- PDF Frontier/orderbook integration audit report
- PDF system security audit report
- patched code
- added regression tests
- a short re-audit memo listing what changed and what residual risk remains
