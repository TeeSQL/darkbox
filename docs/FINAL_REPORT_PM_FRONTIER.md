# DarkBox Prediction-Market × Frontier — Final Report

Status: implementation complete and exercised locally (Anvil + private hidden chain).
Date: 2026-06-13
Scope of this report: the **prediction-market contracts + Frontier orderbook
integration** worker. The public-bridge / shadow-controller USDC-only refactor is
owned by a separate concurrent worker (see §7).

Companion docs: `IMPLEMENTATION_NOTES_PM_FRONTIER.md` (decisions/assumptions),
`MARKET_CREATION_AND_SPLIT_JOIN_SPEC.md` (contract source of truth),
`lib/frontier/PROVENANCE.md` (vendored Frontier provenance).

---

## 1. What was implemented

### 1.1 Prediction-market contracts (`packages/contracts/src`)
- **`lib/ERC20.sol`** — minimal self-contained ERC-20 base (repo convention: no OZ).
- **`SyntheticUSDC.sol`** — hidden-chain synthetic USDC credit (6 dec), `mint`/`burn`
  gated to a `minter` (bridge/coordinator key); `admin` rotates the minter.
- **`markets/MarketTypes.sol`** — `Outcome`, `MarketStatus`, `ResolverType`,
  `ResolverConfig`, `CreateMarketParams` (mirrors the market spec §10).
- **`markets/OutcomeToken.sol`** — ERC-20 YES/NO claim (6 dec, mirrors collateral);
  mint/burn restricted to its owning market.
- **`markets/DarkBoxBinaryMarket.sol`** — per-market collateral vault:
  `split` / `join` (+`merge` alias) / `redeem`, lifecycle
  (Active/Paused/Closed/Resolved/Voided), one-shot resolution, void → each side
  redeems 0.5. Deploys its own YES + NO outcome tokens.
- **`markets/DarkBoxMarketFactory.sol`** — creates/tracks markets, enforces
  creation rules + creator bonds (lock→return on clean resolve / slash on void),
  registers Frontier books, and drives role-gated lifecycle transitions.
- **`interfaces/IFrontier.sol`** — minimal `IFrontierGeoBookFactory` view; the PM
  contracts depend only on this, never on Frontier internals.

### 1.2 Frontier integration (real repo)
- Frontier `main` @ `453b8d6` is vendored at `packages/contracts/lib/frontier`
  (deploy-day src only; the single v4-core-dependent file is omitted). The DarkBox
  foundry project was bumped to `solc 0.8.26 / cancun / via_ir` to match.
- Each binary market gets **two geometric books** via
  `FrontierGeoBookFactory.createGeoBookWithFees(...)`, both quoted in sUSDC:
  - YES book: `token0 = YES`, `token1 = sUSDC`
  - NO  book: `token0 = NO`,  `token1 = sUSDC`
- Book creation is a separate coordinator step (`createBooks`) so market creation
  and order placement stay decoupled (spec §5.4/§7). Fee-enabled APIs are used
  (`feeRecipient`, `makerFeeBps`, `takerFeeBps`); `MakerFee`/`TakerFee` +
  `Deposit`/`IntervalFilled`/`RunFilled`/`Claim`/`Cancel` events are available to
  the indexer.

### 1.3 Scripts / harnesses
- `script/DeployDarkBox.s.sol` — deploys Frontier (registry/deployers/factory/
  lens/router) + sUSDC + market factory, seeds the canonical hackathon-winner
  market, registers its books, writes a deployment JSON.
- `script/live-anvil-e2e.sh` — parametric live check (deploy → verify → split →
  maker ask → taker buy via router → resolve → redeem).
- `infra/node/run-hidden-chain-e2e.sh` — same, against the persistent private
  hidden chain (chain-id 88813, code-size-limit raised, on-disk state).
- `infra/node/Dockerfile` + `README.md` — real anvil-based hidden-chain container.

---

## 2. Test commands and results

### 2.1 Foundry unit + integration suite
```sh
cd packages/contracts
forge test
```
Result (re-run after the concurrent bridge USDC-only refactor landed):
**63 passed, 0 failed** across 4 suites — including the 29-test
`DarkBoxFrontierTest` covering: canonical + derivative creation; duplicate /
empty-question / bad-times / low-bond / unsupported-resolver / canonical-by-
non-admin rejections; initial-liquidity split; split/join/merge; collateral
invariants (`totalYES==totalNO==vaultCollateral`); split-after-close and
redeem-before-resolution guards; resolve-YES/NO with winner-only redeem;
no-double-resolve; void → 0.5/0.5 redeem + bond slash; bond return on resolve;
unauthorized resolve/void/createBooks; direct-lifecycle and outcome-mint
authorization; **Frontier maker deposit + taker buy via router + maker claim**;
Frontier cancel returns principal; **taker fee accrues to fee recipient**.

> Note: this run is after a separate worker's concurrent public-bridge / shadow-
> controller USDC-only refactor landed; the PM/Frontier/sUSDC suites and the
> EIP-712 parity test pass cleanly alongside it. (Count moved 64→63 because the
> bridge worker consolidated an asset-specific bridge test.)

### 2.2 Live Anvil end-to-end
```sh
cd packages/contracts && bash script/live-anvil-e2e.sh
```
Result: **9/9 PASS** — `bookCount==2`, `yesBook` has code (26,159 B),
`token0==YES`/`token1==sUSDC`, market Active, maker ask escrowed YES, taker
received 49e6 YES via router, market Resolved, winner redeemed sUSDC.

### 2.3 Private hidden chain end-to-end
```sh
bash infra/node/run-hidden-chain-e2e.sh
```
Result: **9/9 PASS** on chain-id **88813**, with state persisted to
`infra/node/data/hidden-chain-state.json`.

---

## 3. Deployed addresses (deterministic; identical on 31337 and 88813)

From `packages/contracts/deployments/darkbox-latest.json` (Anvil, 31337) and
`darkbox-private-88813.json` (private hidden chain, 88813):

| Contract | Address |
|---|---|
| Frontier PermissionRegistry | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Frontier GeoBookFactory | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| Frontier Lens | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| Frontier Router | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| SyntheticUSDC (sUSDC) | `0x0165878A594ca255338adfa4d48449f69242Eb8F` |
| DarkBoxMarketFactory | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` |
| Canonical market | `0x9bd03768a7DCc129555dE410FF8E85528A4F88b5` |
| Canonical YES token | `0xb14D33721D921fA72Eae56EfE9149caF7C7f2736` |
| Canonical NO token | `0xcdA074FebAd146910539E2B12D0Fc80acF4359d9` |
| Canonical YES book | `0xbf9fBFf01664500A33080Da5d437028b07DFcC55` |
| Canonical NO book | `0x93b6BDa6a0813D808d75aA42e900664Ceb868bcF` |

(Deployer / acct0 = `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`. Addresses are
CREATE-deterministic from the deployer nonce sequence on a fresh chain.)

---

## 4. Ownership / admin configuration

### 4.1 Role matrix (PM/Frontier layer — this worker)

| Role | Contract / field | Power | MVP holder | Target |
|---|---|---|---|---|
| Factory admin | `DarkBoxMarketFactory.owner` | creation rules, fees/bonds, pause/close/void, set coordinator/frontier/treasury/book-params, rotate owner | deployer EOA | **multisig (Safe)** |
| Book coordinator | `DarkBoxMarketFactory.coordinator` | `createBooks` (register Frontier books) | operator EOA (hot) | operator EOA, rotatable by admin |
| Per-market resolver | `ResolverConfig.resolver` (immutable per market) | `resolveMarket` for that market | canonical: judge/admin; derivative: creator or admin | multisig / designated judge |
| Pause / close | factory `owner` **or** market `resolver` | `pauseMarket` / `resumeMarket` / `closeMarket` | as above | as above |
| Void | factory `owner` only | `voidMarket` (+ slash bond) | deployer EOA | **multisig** |
| sUSDC admin | `SyntheticUSDC.admin` | rotate minter, rotate admin | deployer EOA | **multisig** |
| sUSDC minter | `SyntheticUSDC.minter` | mint/burn synthetic credit 1:1 vs deposits | bridge/coordinator EOA (hot, in TEE) | bridge coordinator key, rotatable by admin |
| Frontier fee recipient | per-book immutable (set via factory book-params at registration) | receives maker/taker fees | DarkBox `treasury` | treasury multisig |
| Bond treasury | `DarkBoxMarketFactory.treasury` | receives slashed creator bonds | deployer EOA | treasury multisig |

Frontier `GeoBookFactory` / `Router` / `Lens` are **ownerless** (permissionless
book creation; stateless periphery). `PermissionRegistry` has no global admin —
it stores per-user, selector-scoped, expirable delegations that maker agents use.

### 4.2 Deployer ownership-transfer plan
1. Deploy from a single deployer EOA that initially holds: factory `owner` +
   `coordinator`, sUSDC `admin` + `minter`, `treasury`, canonical resolver.
2. Hand off **governance** roles to a multisig:
   - `DarkBoxMarketFactory.setOwner(multisig)`
   - `SyntheticUSDC.setAdmin(multisig)`
   - `DarkBoxMarketFactory.setTreasury(treasuryMultisig)`
   - re-point canonical resolver via the next market's `ResolverConfig` (resolver
     is immutable per market; set it correctly at creation).
3. Keep **operational** roles as rotatable hot keys held by the TEE/bridge service:
   - `coordinator` (book registration), sUSDC `minter` (deposit credit).
   These are low-blast-radius and must be rotatable by the multisig admin.

### 4.3 Multisig vs EOA for MVP
- **Multisig (recommended): factory owner, sUSDC admin, treasury, void authority,
  canonical resolver.** These can move/lock funds or invalidate markets.
- **EOA hot keys (acceptable): coordinator, minter** — operational, rotatable,
  ideally held inside the TEE. For a hackathon demo a single EOA for everything is
  acceptable **only** with this documented and a pre-written transfer step.

---

## 5. Key engineering findings

1. **Frontier `GeometricFrontierBook` exceeds EIP-170.** Runtime is 26,159 B at
   the deploy profile (runs=200) and **25,228 B even at `optimizer-runs=1`** — both
   over the 24,576 B limit. That limit is a hard-coded consensus constant in
   go-ethereum and reth (revm) and is **not** genesis-configurable, so neither geth
   nor reth can host the real Frontier book. The DarkBox hidden chain uses anvil
   with `--code-size-limit` (it owns its genesis). **This also means the real
   Frontier book cannot deploy to vanilla Base mainnet as-is** despite the repo's
   "EIP-170 chains" note — flagged for the Frontier team.
2. **Prediction-market books need fine tick spacing.** Frontier rounds *partial*
   taker fills inside a single wide interval down to zero, so the factory defaults
   to `tickSpacing = 1` (finest geometric granularity). With one wide interval a
   50e6 buy quoted 0; with `tickSpacing=1` it correctly fills 49e6.
3. **`forge script --broadcast` intermittently hangs** in this environment on the
   batched-send path; `--slow` (sequential, receipt-waited) is reliable. The
   helper scripts use `--slow`.
4. **Outcome tokens mirror collateral at 6 decimals** so split/join/redeem are
   exactly 1:1 and the collateral invariant is exact.

---

## 6. Remaining risks / open questions

- **Code-size limit dependency:** the hidden chain must run with a raised
  code-size limit. Documented and automated, but it is a non-standard chain config
  that any production target must support.
- **Void policy incentive caveat:** voided markets settle each side at 0.5 USDC,
  which changes incentives if voiding happens after meaningful trading. Keep
  voiding rare (documented in the market spec §6.4).
- **Resolver immutability:** a market's resolver is fixed at creation. Correcting a
  mis-set resolver requires void + recreate. Acceptable for MVP; revisit if
  governance needs to reassign resolvers.
- **N-ary canonical market:** the canonical "which project wins" market is modeled
  as a binary "will <project> win?" per the MVP binary mandate. Multi-outcome is
  out of scope.
- **Frontier upstream:** vendored at a pinned commit with no package release; track
  Frontier `main` and re-vendor + re-test on updates.

---

## 7. Coordination note (bridge / shadow controller)

A separate worker is concurrently converting the public bridge + shadow controller
to USDC-only (no `asset` param, no ETH/WETH, no `supportedAsset` allowlist; the
EIP-712 `WithdrawalAuthorization`/`WithdrawCommand` typehashes drop the `asset`
field, with matching `packages/shared` TS + parity tests). The PM/Frontier/sUSDC
layer in this report is **already USDC-only by construction** (single `sUSDC`
collateral; YES/NO traded only vs sUSDC; no asset parameter anywhere) and needs no
change for that directive. This report's `forge test` numbers reflect the tree
before that refactor; re-run once it lands.
