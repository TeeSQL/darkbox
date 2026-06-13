# @darkbox/reveal — reveal bundle builder

The "open the box" service. Composes the indexer's INTERNAL derived state +
on-chain deploy metadata into one **auditable, replay-driving** bundle, with an
accounting reconciliation and an integrity hash.

Confidential plane: it reads indexer `/internal/*`, so it runs on `hidden_net`
and never on `public_net`. Publishing the bundle externally is a deliberate,
separate step — building it is not publishing it.

## Bundle contents

- `meta` — game id, title, builtAt, reveal policy
- `deployments` — on-chain addresses (from `packages/contracts/deployments/*.json`)
- `markets`, `orders`, `fills`, `positions`, `leaderboard`, `agents`
- `accounting` — public-USDC vs shadow reconciliation:
  `reconciled = (shadowMinted == publicDeposited + promoCredited)`, with the
  signed `discrepancyUsdc` (micro-USDC integer math, no float drift)
- `timeline` — replay events (marketing 05 schema), sorted, with a
  `reveal_opened` beat
- `integrity` — `bundleHash` (keccak256 over a deterministic serialization) +
  `eventCount`

## Reveal policy

Strategy preimages (`revealedInstruction`) are included **only** when
`REVEAL_INCLUDE_INSTRUCTIONS=true`. Hashes are always present so commitments stay
verifiable even when preimages are withheld.

## Usage

One command builds the bundle + timeline:
```bash
INDEXER_INTERNAL_URL=http://darkbox-indexer:8080/internal \
DEPLOYMENTS_DIR=packages/contracts/deployments \
REVEAL_OUT_DIR=.artifacts/reveal \
pnpm --filter @darkbox/reveal build:bundle
# -> .artifacts/reveal/reveal-0x00000000.json  (+ timeline-*.json)
```

On-demand HTTP (internal only):
```
GET /internal/reveal/bundle     # builds + returns the bundle
GET /internal/reveal/timeline   # just the replay timeline
GET /health
```

The HTTP source is defensive: missing indexer endpoints degrade to empty arrays
so a bundle can always be produced; `accounting.reconciled` surfaces any gap.

## Run

```bash
pnpm --filter @darkbox/reveal typecheck
pnpm --filter @darkbox/reveal test
```
