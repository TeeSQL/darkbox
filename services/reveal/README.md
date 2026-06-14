# darkbox-reveal

Post-game audit bundle builder. Pulls the canonical export from the indexer
(`/internal/reveal/export`), computes a stable content digest, runs
internal-consistency checks, and serves the packaged bundle.

The bundle contains everything an independent party needs to replay and verify
the game: the full ordered engine action log, registration commitments
(identities), the final leaderboard, markets, and the billboard. Because the
engine is deterministic, replaying `actions` through a fresh engine reproduces
`finalLeaderboard` exactly.

## API

- `GET /reveal/health`
- `POST /reveal/build` — fetch + package the current bundle, return digest/summary
- `GET /reveal/digest` — digest, byte size, action/agent counts, consistency issues
- `GET /reveal/bundle` — the full packaged bundle

## Next step

Full cryptographic replay-verification (re-run `actions` through the engine and
assert the leaderboard matches) — the bundle already carries the complete action
log that makes this possible for any verifier.

See ../../docs/TECH_SPEC.md for the reveal bundle contract.
