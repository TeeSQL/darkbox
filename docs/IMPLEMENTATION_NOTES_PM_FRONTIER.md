# DarkBox PM + Frontier Implementation Notes / Open Questions

Status: living note for the prediction-market + Frontier integration work.
Last updated: 2026-06-13
Author: coding agent (Opus)

This note records implementation decisions, assumptions made where the spec left
choices open, and genuine blockers. It is the companion to
`MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md` and `TECH_SPEC.md`.

## 1. Frontier integration (RESOLVED — real repo used)

The real, finalized Frontier repo is available locally at
`/home/ubuntu/frontier-orderbook` (prototype foundry project). It is the source
of truth. **Integration target: Frontier `main` commit
`453b8d6d416a5bd0376733434303ca873c91a2d7`** ("merge fee-enabled deploy
package"). `main` supersedes the earlier `deploy-ready-fees-skill` snapshot
(3b4219e); the 37 newer commits on main do not change `prototype/src`, so the
vendored contracts are byte-identical at both — but main is the canonical
reference. (An even earlier draft of this note worked around the repo being
inaccessible by proposing a custom CLOB — that plan is dropped; no custom CLOB
exists.)

**What Frontier is:** a thin-tick, geometric (Uniswap-v3-style) on-chain CLOB.
A "book" is a venue for one `(token0, token1)` pair on a geometric price curve
(`1.0001^tick`). `token0` is the base asset (sold by asks / bought by bids);
`token1` is the quote.

**Deploy-day path (per `docs/frontier-abi-interface.md`, the canonical source):**

- `PermissionRegistry` — selector-scoped maker-agent delegation.
- `GeometricBookDeployer`, `GeometricOpsDeployer` — thin initcode deployers
  (keep the factory under EIP-170).
- `FrontierGeoBookFactory(registry, geoBookDeployer, geoOpsDeployer)` — creates
  geometric books via `createGeoBookWithFees(token0, token1, tickSpacing,
  startTick, feeRecipient, makerFeeBps, takerFeeBps) → book`.
- `FrontierLens` — `quoteBuy/quoteSell/depth/summary`.
- `FrontierRouter(factory, lens)` — `buyExactIn/sellExactIn/swapExactTokensForTokens`.

**Maker/taker ABI used by the agent runtime + tests:**

- Maker ask (sell token0): `book.deposit(lower, upper, liquidity) → positionId`.
- Maker bid (buy token0 with token1): `book.depositBid(lower, upper, liquidity) → positionId`.
- Cancel: `book.cancel(id)` / `book.cancelBid(id)`; claim: `book.claim(id)` / `book.claimBid(id)`.
- Taker buy token0: `router.buyExactIn(book, amount1In, minOut0, to, deadline)`.
- Taker sell token0: `router.sellExactIn(book, amount0In, minOut1, to, deadline)`.
- Approvals: makers approve the **book**; takers approve the **router**.

**DarkBox ↔ Frontier wiring (Pattern A, ERC-20 outcomes):** each binary market
gets **two geometric books**, both quoted in synthetic USDC:

- YES book: `token0 = YES outcome token`, `token1 = sUSDC`.
- NO  book: `token0 = NO  outcome token`, `token1 = sUSDC`.

YES/NO prices live in (0,1) sUSDC, i.e. near tick 0 (`1.0001^0 ≈ 1.0`). Books
are created through a coordinator call on `DarkBoxMarketFactory.createBooks(...)`
**after** market creation, keeping market-creation and order-placement decoupled
(spec §5.4/§7). The PM contracts depend only on a minimal
`IFrontierGeoBookFactory` interface, so they never import Frontier internals.

**Vendoring:** Frontier's deploy-day `src` is copied into
`packages/contracts/lib/frontier/` (see `lib/frontier/PROVENANCE.md`) and exposed
to the DarkBox foundry project via the remapping `frontier/=lib/frontier/`. Only
the deploy-day closure is referenced; the single v4-core-dependent file
(`RangeTakeProfitHook.sol`) is omitted. The DarkBox foundry project is bumped to
`solc 0.8.26 / evm cancun / via_ir` to match Frontier.

**Genuinely unverifiable detail:** none remaining — the live ABI doc + tests in
the real repo are authoritative.

## 2. Resolved implementation choices (spec §13 "Open Implementation Choices")

| Choice | Decision | Why |
|---|---|---|
| ERC-20 per outcome vs ERC-1155 + adapter | **ERC-20 per outcome (Pattern A)** | Spec default recommendation; cleanest CLOB compatibility; clear balances/allowances. |
| Per-market deploy vs clones | **Plain per-market deploy** of `DarkBoxBinaryMarket` + 2 `OutcomeToken`s | Simplest robust path for MVP/hackathon; clone factory is a later gas optimization. Documented as a known cost. |
| Who creates Frontier books | **Coordinator/factory registers books after market creation**, separate from order placement | Spec §5.4 + §7: keep market creation and order placement decoupled. Factory exposes the YES/NO token addresses; a coordinator call registers the two books. |
| Creator bond amount | **Configurable on factory; default 10 USDC (10e6)** | Spec leaves exact amount open; small anti-spam bond, admin-tunable. |
| Void policy for traded markets | **Resolve-to-`Invalid` → YES and NO each redeem 0.5 collateral per token** | Spec's "cleaner MVP alternative". Deterministic, fully on-chain, no admin pro-rata unwind needed. Paired join also still works. Documented incentive caveat. |
| Collateral / outcome decimals | **6 decimals** (synthetic USDC) | 1 USDC ↔ 1 YES + 1 NO is exact; outcome tokens mirror collateral decimals. |
| Price representation | **Frontier geometric ticks** (`1.0001^tick`); YES/NO quoted in sUSDC near tick 0 | We use Frontier's native curve; no custom price scaling. Books start at `startTick` (default 0 ≈ price 1.0) with `tickSpacing` (default 60). |
| Book token ordering | `token0 = outcome (YES/NO)`, `token1 = sUSDC` | token0 is Frontier's base (sold by asks/bought by bids); price reads as sUSDC per outcome token. |

## 3. Synthetic collateral

- Hidden-chain collateral is `SyntheticUSDC` (ERC-20, 6 decimals) — gameplay credit
  minted 1:1 against confirmed public deposits (TECH_SPEC §10/§12).
- Minting is restricted to a `minter` role (the bridge/coordinator key). Tests and
  deploy scripts grant minter to the deployer/coordinator.
- The factory pulls creator bonds + initial liquidity in this token.

## 4. Roles (full matrix lives in FINAL_REPORT once deployed)

- `factory.owner` (admin): create-window config, fees/bonds, pause/close/void, set resolver registry.
- `resolver` (per-market, via `ResolverConfig`): may call `resolveMarket`.
- `SyntheticUSDC.minter`: bridge/coordinator key.
- `FrontierCLOB.coordinator`: registers books for new markets.
- pause/void: factory admin (and per-market resolver for resolve).

## 5. Assumptions on lifecycle

- `Draft` collapsed into immediate `Active` on creation (spec §4 allows this).
- `join` allowed in `Active` and `Closed` (unresolved); blocked when `Paused`,
  `Resolved`, `Voided` (except void uses redeem path).
- `split` allowed only in `Active`.
- `redeem` allowed only in `Resolved` (winning outcome) or `Voided` (both at 0.5).
- Resolution is one-shot; cannot resolve twice; cannot resolve a voided market.

## 6. Things still genuinely underspecified (flagged, not blocking)

- Whether the canonical hackathon-winner market should be N-ary (multiple projects)
  rather than binary. Spec mandates binary YES/NO for MVP, so the canonical market
  is modeled as "Will <project> win?" binary. Multi-outcome is out of scope.
- Exact creation-window / game-deadline enforcement is modeled with `closeTime` /
  `resolveBy` timestamps on the factory; the game-level freeze lives in the bridge/
  indexer layer, not the market contracts.
- Fee destination (treasury vs prize pool) — modeled as a single `treasury` address.
