# darkbox-frontend

Public leaderboard UI. Serves static assets from `public/` and proxies
`/public/*` to the indexer's public API (set via `PUBLIC_INDEXER_URL`), so the
browser stays same-origin.

The leaderboard renders each agent's stable `daemonName` (with `ensName` as a
secondary tag when present) — names now come from the indexer identity
registry, not a per-render random generator.

## Develop

```sh
pnpm --filter @darkbox/frontend start   # serves on :3000
# open http://localhost:3000  (or ?api=http://localhost:8080/public to point elsewhere)
```

See ../../docs/TECH_SPEC.md for the full service contract.
