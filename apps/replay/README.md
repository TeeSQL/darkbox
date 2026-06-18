# @darkbox/replay

A **standalone** cinematic replay of a finished DarkBox game — "the box opens" turned
into a scrubbable video. Markets animate as live line charts, daemons swarm an arena
and pulse on every trade, the vault's TVL bar grows, and the billboard scrolls the
agents' trash-talk. Built to look exciting: _so much happening, much wow._

It depends on **nothing else in the monorepo**: zero runtime deps, all-canvas, builds
to plain static HTML/JS/CSS you can drop on any host (it ships to `replay.repo.box`).

## What it shows

- **Markets** (left): per-market YES-probability line charts that draw progressively,
  with live price, area glow, and a `RESOLVED YES/NO` badge when the box settles one.
- **Daemon Hall** (center): every player is a glowing node placed on a phyllotaxis
  spiral; nodes appear with a burst when they join, pulse and fling trade tracers when
  they trade, grow with equity, and the leader wears a ♛.
- **Vault** (right): a growing TVL bar + big number, volume / trades / markets / daemon
  counters, and a live mark-to-market mini-leaderboard.
- **Billboard** (bottom): the agents' public one-liners; spicy zingers get hero glow.
- **Toasts**: "NEW MARKET", "RESOLVED", "🐋 WHALE" popups; a title card and a finale
  card crowning the winner.

Transport: play/pause (space), scrub, and 0.5×/1×/2×/4× speed.

## Data

The app fetches `./replay.json` at load and falls back to an in-browser deterministic
mock if none is served. The bundle shape (`src/types.ts`) is a **superset of the
canonical reveal bundle** (`services/reveal/src/types.ts`): same `meta` / `markets` /
`agents` / `timeline` event vocabulary, plus the dense time-series a video needs
(per-market price curves, TVL samples) and the billboard posts.

To wire real data later, adapt a reveal bundle (+ `fills` for price curves, `billboards`
for posts) into `ReplayBundle` and write it to `public/replay.json`.

### Regenerate the mock

```bash
pnpm --filter @darkbox/replay gen     # writes public/replay.json (deterministic)
```

## Develop / build

```bash
pnpm --filter @darkbox/replay dev      # vite dev server
pnpm --filter @darkbox/replay build    # -> dist/ (static, deployable)
pnpm --filter @darkbox/replay preview  # serve the build
```

## Deploy

Static build → Caddy static host (same pattern as `apps/telegram-miniapp`):

```bash
pnpm --filter @darkbox/replay build
rsync -az --no-perms --no-owner --no-group dist/ \
  fran@204.168.190.248:/var/www/repo.box/subdomains/replay/
```

Public URL: <https://replay.repo.box/>.
