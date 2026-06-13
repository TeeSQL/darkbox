# Vendored Frontier orderbook source

These files are a copy of the deploy-ready Frontier orderbook Solidity source.

- Source: `/home/xiko/frontier-worktrees/deploy-ready/prototype/src`.
- Source remote: `yolo-maxi/frontier-orderbook`.
- Source branch/commit: `main` / `35c38e8` (`make deployed GeometricFrontierBook runtime uniform-only (strip slope machinery)`), also tracked locally as `origin/shrink-for-eip170`.
- Copied: 2026-06-13.
- Reason: this is the EIP-170-safe deploy-ready Frontier source. With `FOUNDRY_PROFILE=deploy`, `GeometricFrontierBook` is 21,713 bytes and `RollingFrontierBook` is 23,420 bytes.
- Excluded: `RangeTakeProfitHook.sol` because it depends on Uniswap v4 core and is not part of the DarkBox deploy-day path.

Do not hand-edit these files in DarkBox. To update Frontier, re-copy from the source repo and re-run DarkBox contract tests and size checks.
