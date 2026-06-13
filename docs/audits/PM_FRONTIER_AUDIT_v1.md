# DarkBox — Prediction-Market & Frontier-Integration Contract Audit (v1)

Date: 2026-06-13 UTC
Auditor: Dan's security agent (AI-assisted multi-pass review + manual verification)
Branch audited: `feat/pm-frontier-integration` @ `e72f532`
Scope: the **new** DarkBox-authored market contracts and the **DarkBox↔Frontier
integration boundary** — the surface the original handover audit explicitly could
**not** cover because the code did not exist yet (`AUDIT_PLAN.md` §4).

## Scope

In scope (DarkBox-authored):
- `src/markets/DarkBoxBinaryMarket.sol` (241 L)
- `src/markets/DarkBoxMarketFactory.sol` (424 L)
- `src/markets/OutcomeToken.sol`, `src/markets/MarketTypes.sol`
- `src/SyntheticUSDC.sol`
- `src/interfaces/IFrontier.sol` and the call-sites into the vendored Frontier books

Out of scope: upstream Frontier internals (vendored from Frontier `main` @
`453b8d6`, per `lib/frontier/PROVENANCE.md`) were reviewed only to establish the
custody/settlement contract, not re-audited. `DarkBoxBridge` / `ShadowBridge
Controller` were covered by the prior audit (`CONTRACT_AUDIT_REPORT.md`); 64
forge tests pass across the suite at this commit.

Method: three parallel specialist passes (market core; factory + SyntheticUSDC;
Frontier boundary) followed by manual source verification of the highest-impact
findings against exact line numbers, then product-context triage.

## Product-context triage (carried from prior audit)

**FP-01 — Per-user "deposit cap" on withdrawals is a FALSE POSITIVE**, reaffirmed.
Winners can redeem/withdraw more than they personally deposited — losers fund
winners; that is the game. The real security boundary is hidden-ledger + TEE/signer
correctness, not per-user caps. No finding below contradicts this.

## Summary

The **core collateral invariant is sound**: `1 collateral == 1 YES + 1 NO` holds
across split/join/merge/resolve/void; minting is correctly locked
(`OutcomeToken` is `onlyMarket`; `SyntheticUSDC` is `onlyMinter` and **no market
or user can mint shadow collateral** — there is no infinite-money path). The
`DarkBoxBinaryMarket` vault is **fully segregated from Frontier** (it never
approves or calls a book), so no Frontier code path can touch split/redeem
collateral.

The actionable findings cluster in **market governance/creation** and the
**trust-on-book-creation** boundary, plus one **economic mis-configuration**.

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| M-1 | Question-hash omits `gameId` → cross-game DoS / front-run griefing of creation | Medium | **Verified** |
| M-2 | Permissionless `createMarket` + creator-set resolver → self-listed/self-resolved markets | Medium | **Verified** |
| M-3 | Frontier books stored without validation; `frontierFactory` swappable; pair re-creatable | Medium | Confirmed |
| M-4 | `bookStartTick = 0` puts the ask book at price > 1.0 for a (0,1) token | Medium (economic) | Confirmed |
| L-1 | Creator can self-resolve AdminManual market and reclaim its bond | Low | Confirmed |
| L-2 | No on-chain close-time enforcement; split open until factory `close()` | Low | Confirmed |
| L-3 | Void redeem `amount/2` truncation strands dust; no rescue path | Low | Confirmed |
| L-4 | `createMarket` does not reset factory→market approval | Low | Confirmed |
| L-5 | Cancel test lacks partial-fill coverage (no live bug) | Low | Confirmed |
| L-6 | 6-dec collateral vs 1e18 price scale fragile if `tickSpacing` coarsened | Low | Confirmed |
| I-1 | Trusted-operator centralization (one key = minter/admin/owner/coordinator) | Info | Expected (MVP) |
| I-2 | `coordinator`/`feeRecipient` settable to `address(0)` | Info | Confirmed |
| I-3 | `redeem` lacks `nonReentrant` (safe with current no-hook token) | Info | Confirmed |
| I-4 | EIP-170: book ~26 KB needs `anvil --code-size-limit`; can't deploy to stock chains | Info | Confirmed |
| I-5 | No DarkBox-granted standing approvals to Frontier (positive) | Info | Confirmed |
| I-6 | Taker fee cannot be evaded/siphoned at the boundary (positive) | Info | Confirmed |

## Findings

### M-1 — Question-hash omits `gameId` → cross-game DoS / front-run griefing
**Medium · `DarkBoxMarketFactory.sol:147-153, 226-233, 63` · verified against source**

`computeQuestionHash(question, resolverType, closeTime, metadataURI)` does **not**
include `gameId`, and `questionHashUsed` is a **global, never-reset** mapping
(line 63, set at 150-151) — yet `marketId = keccak256(abi.encode(gameId,
questionHash))` *does* include `gameId` (line 153). Two legitimately distinct
markets (different games, identical wording/close/metadata) collide on the guard.
Because `createMarket` is permissionless (M-2), anyone can pre-register a hash for
the price of a (refundable) junk-market bond and **permanently block** a real
market — including the privileged **canonical** market, whose strings are fixed
and public in `DeployDarkBox.s.sol`.

Fix: hash `gameId` into `computeQuestionHash` and key `questionHashUsed` by it.
Gating creation (M-2) also mitigates.

### M-2 — Permissionless `createMarket` + creator-controlled resolver
**Medium · `DarkBoxMarketFactory.sol:136-208` · verified (no `onlyOwner` on `createMarket`)**

Only the `CanonicalWinner` branch is gated (lines 143-145). Any address holding
`minCreatorBond` sUSDC can create AdminManual markets, deploy the market + outcome
tokens, set itself as `resolver` (unvalidated), and — once a coordinator runs
`createBooks` — get YES/NO listed on real Frontier books. Contradicts the "sealed,
operator-curated arena" model and enables spam (up to `maxMarketsPerCreator` per
address) and creator-self-resolution (L-1).

Fix: gate `createMarket` to `owner`/`coordinator` (or an allowlist) for the MVP;
if open creation is intended, force AdminManual `resolver` to a curated set.

### M-3 — Frontier books stored without validation; factory swappable; pair re-creatable
**Medium · `DarkBoxMarketFactory.sol:251-262, 361-364` (+ Frontier `defaultBook` routing)**

`createBooks` stores whatever `frontierFactory.createGeoBookWithFees(...)` returns
with no post-conditions (no check that `token0`/`token1`/spacing/fees match, or
that the books are non-zero and distinct), latching `booksRegistered = true`.
`frontierFactory` is owner-mutable (`setFrontierFactory`). Separately, the real
Frontier factory lets anyone create a book for a known `(outcomeToken, sUSDC)`
pair, so router/aggregator `defaultBook` routing can be shadowed by an
attacker-controlled book with hostile fees/recipient. This endangers **traders'**
funds resting in books — **not** the segregated DarkBox vault.

Fix: assert `yesBook!=0 && noBook!=0 && yesBook!=noBook` and
`book.token0()==outcomeToken && book.token1()==collateral && tickSpacing/fees`
match after creation; treat DarkBox's recorded book addresses (via `getBooks`) as
the only source of truth for the indexer/frontend; consider an immutable or
timelocked `frontierFactory`.

### M-4 — `bookStartTick = 0` inverts a (0,1) prediction market
**Medium (economic) · `DarkBoxMarketFactory.sol:54-56` + geometric curve `P(0)=1e18`**

With `bookStartTick=0`, the geometric curve sets `P(0)=1.0` sUSDC. Asks require
`tick > 0` → price **> 1.0** sUSDC per outcome token; bids require `tick ≤ 0` →
price ≤ 1.0. A binary outcome token is worth between 0 and 1 sUSDC, so the entire
**ask side is at economically impossible prices** and only the bid side is usable.
A taker buying via the ask pays > 1.0 for something that redeems for ≤ 1.0 —
guaranteed loss. The integration tests pass only because they assert
`received>0 / paid>0`, never that price ∈ (0,1).

Fix: set `bookStartTick` to a negative mid-band tick (≈ `ln(0.5)/ln(1.0001) ≈
-6931` for a 0.50 reference) so both sides straddle a real probability; add a test
asserting realized price ≤ 1.0 sUSDC.

### L-1 — Creator can self-resolve AdminManual market and reclaim bond
**Low · `DarkBoxMarketFactory.sol:286-294, 311-318`**

`resolveMarket` allows `msg.sender == owner || == m.resolver()`; the creator sets
`resolver` freely (M-2), so the creator resolves to any outcome and `_returnBond`
refunds the bond in the same tx — the bond provides no honest-resolution
guarantee. Bond is only slashed via owner-only `voidMarket`.

Fix: disallow creator==resolver for non-owner-created markets; combine with M-2.

### L-2 — No on-chain close-time enforcement
**Low · `DarkBoxBinaryMarket.sol:40-41, 120-121`**

`closeTime`/`resolveBy` are stored immutables but **never read**; `split` is gated
only on `status == Active`. Trading/minting stays open past the advertised close
until a privileged factory caller invokes `close()`. An informed user can `split`
after the real-world outcome is effectively known but before status flips.

Fix: add `if (block.timestamp >= closeTime) revert ...;` to `split`; optionally
allow anyone to permissionlessly transition `Active→Closed` after `closeTime`.

### L-3 — Void redeem `amount/2` truncation strands dust
**Low · `DarkBoxBinaryMarket.sol:166-175`**

On void, each side redeems `amount/2` (integer division). Odd balances (routine
after partial fills) truncate ½-unit per redemption; the token burns but the
collateral is never released, and there is **no sweep/rescue** function — so dust
is locked forever. Strictly *under*-releases (never a drain).

Fix: round one leg consistently and/or add an `onlyFactory` residual sweep; or
redeem void 1:1 against a single side.

### L-4 — `createMarket` does not reset factory→market approval
**Low · `DarkBoxMarketFactory.sol:203-207`**

`approve(market, initialLiquidity)` then `m.split(...)` nets to zero **only**
because the current market pulls exactly `amount` from a no-fee token. A future
market variant or fee-on-transfer/partial-pull collateral would leave a residual
allowance over the factory's pooled-bond balance.

Fix: zero the allowance after `split`, or have the market pull initial liquidity
from the creator directly.

### L-5 — Cancel test lacks partial-fill coverage
**Low · `test/DarkBoxFrontier.t.sol` (cancel path)**

`test_FrontierCancelReturnsPrincipal` only cancels an *unfilled* order.
Double-withdraw is structurally prevented in Frontier (`p.live` retirement +
`claimedUpper` cursor), so this is a **coverage gap, not a live bug**: a regression
in partial-cancel accounting would not be caught.

Fix: add deposit → partial fill → cancel → assert `proceeds1>0 && principal0>0`
and a second cancel/claim reverts/pays 0.

### L-6 — 6-dec collateral vs 1e18 price scale fragile under coarser spacing
**Low · `SyntheticUSDC.sol` (6 dec) + Frontier `PRICE_SCALE=1e18`**

At the default `tickSpacing=1` rounding is sub-wei-of-sUSDC and
contract-favorable. `setBookParams` permits any `tickSpacing>0`; a coarser spacing
on small orders could floor a fill's cost/output to 0.

Fix: keep `tickSpacing=1` for these markets; guard/document the constraint; add a
1-wei-size "cannot be taken for 0" test.

### Informational
- **I-1 Centralization (expected MVP):** one key is `SyntheticUSDC` minter+admin,
  factory owner, coordinator, fee recipient, and treasury. No unauthorized path;
  risk is key compromise (→ unlimited sUSDC / bond seizure). For mainnet: split
  roles, multisig/timelock the admin, rate-limit minting.
- **I-2** `setCoordinator`/`setFeeRecipient` lack zero-checks (operator foot-gun;
  no attacker path).
- **I-3** `redeem`/`split`/`join` have correct CEI ordering and the in-repo token
  has no hooks, so reentrancy is not exploitable; add `nonReentrant` +
  reject-fee-on-transfer as defense-in-depth.
- **I-4** `GeometricFrontierBook` runtime ~26 KB exceeds EIP-170 (24,576 B); the
  hidden chain runs `anvil --code-size-limit`. These markets **cannot** deploy to
  a stock EVM (mainnet/standard L2 or a geth/reth genesis without the override)
  until the book is slimmed. Availability/portability, not collateral risk.
- **I-5 (positive)** DarkBox grants **no** standing ERC20 approvals to Frontier;
  the only approve is the exact-amount factory→market one.
- **I-6 (positive)** Taker fees are configured-but-not-handled by DarkBox and
  pulled atomically by the book to an immutable recipient — no evasion/siphon at
  the boundary.

## Assessment

Collateral **solvency** is sound under the stated product model: no unauthorized
mint, no wrong-side/double redeem, no path releasing more collateral than locked,
and the vault is insulated from Frontier. The priority **fixes before a judged
demo with real listings** are M-1 (cheap creation DoS that can brick the canonical
market) and M-2 (permissionless creation + self-resolve); M-3 and M-4 should be
fixed before any real trading. Everything else is hardening or expected-MVP
centralization. None of the findings reintroduce the deposit-cap false positive.

## Fix loop (next pass)

Per `AUDIT_PLAN.md` §F: patch M-1/M-2 (gate creation + hash `gameId`), add
regression tests (front-run-blocked-creation; non-owner cannot create/resolve),
fix M-4 start-tick + price-band test, add M-3 book-validation asserts, re-run
`forge test`, and re-audit only the changed surfaces. Then regenerate the PDF into
`docs/audits/pdf/` (and mirror to `handover/dan/audits/pdf/`).

---
*AI-assisted local audit. Not a substitute for an independent human security
review before handling meaningful funds. Findings are engineering evidence to
verify, not final authority.*
