# Vendored Frontier orderbook source

These files are a **verbatim copy** of the deploy-day Solidity source from the
finalized Frontier orderbook repo.

- Source: `/home/ubuntu/frontier-orderbook/prototype/src`.
- Branch: `main`.
- Commit: `453b8d6d416a5bd0376733434303ca873c91a2d7` ("merge fee-enabled deploy
  package") — the integration target. `main` contains the
  `deploy-ready-fees-skill` line (3b4219e) plus 37 newer commits; those newer
  commits do not modify `prototype/src` (verified: `diff -rq prototype/src` is
  byte-identical to this vendored copy at main HEAD).
- Copied: 2026-06-13. Verified `diff -rq` clean against the source `src/` at main
  453b8d6 (only this PROVENANCE.md added and `RangeTakeProfitHook.sol` excluded).
- This is the **fee-enabled** package: DarkBox uses the fee APIs
  (`createGeoBookWithFees`, `feeRecipient`, `makerFeeBps`, `takerFeeBps`) and the
  `MakerFee`/`TakerFee` events are available for the indexer.
- Excluded: `RangeTakeProfitHook.sol` — the only file that depends on
  `v4-core` (Uniswap v4). It is **not** part of the Frontier deploy-day path
  (hooks are explicitly out of scope per `docs/frontier-abi-interface.md`), so
  omitting it keeps this vendored copy dependency-free.
- Untouched otherwise: all internal imports are relative and resolve within this
  tree. DarkBox code imports Frontier via the remapping `frontier/=lib/frontier/`.

Do not edit these files. To update Frontier, re-copy from the source repo and
re-run the DarkBox integration tests. If the real repo gains git history or a
package release, prefer pinning to a tagged commit here.

The DarkBox prediction-market contracts depend only on the minimal
`IFrontierGeoBookFactory` interface (see `src/interfaces/IFrontier.sol`), so they
are insulated from Frontier internals; this vendored copy is used by the deploy
scripts and integration tests to deploy the real Frontier stack.
