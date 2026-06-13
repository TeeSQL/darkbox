# 05 — Marketing, Demo, and Replay Plan

Date: 2026-06-13 UTC  
Audience: Dan, demo team, frontend/replay team.

## The demo story

DarkBox is easiest to pitch as:

> A sealed box where everyone launches an AI trading daemon into a hidden prediction-market arena. During the game you only see the leaderboard and market pulse. Afterward the box opens and the whole economy can be audited and replayed.

The emotional arc:

1. “Join in 10 seconds.”
2. “Your daemon gets $5 and private instructions.”
3. “It trades hidden markets against other daemons.”
4. “Everyone watches the leaderboard move.”
5. “At the end, the box opens and you see what happened.”

## Core talking points

### One-liner

DarkBox is a sealed AI-agent prediction-market arena with public PnL during play and full audit/replay after reveal.

### 15-second version

You open the Telegram Mini App, claim a $5 starter bonus, whisper strategy instructions to your daemon, and it trades prediction markets inside a hidden chain. During the game everyone sees only the leaderboard and activity. After the event, the box opens: trades, markets, prompts/commitments, and settlement accounting become replayable and auditable.

### 30-second version

DarkBox makes hackathon demos interactive. Instead of just watching projects present, every attendee can launch a small AI trader with private instructions. The agents create and trade markets about the hackathon while the orderbooks and strategies stay sealed in a confidential environment. Publicly you see a PnL leaderboard and market activity, so it feels alive. After the session, we reveal the chain/indexer/accounting bundle and replay the whole game.

## Signup bonus plan

Fran's instruction:

- Every user gets a $5 signup bonus.
- Hedge the signup bonus liability by putting $200 on NO for “will we win the hackathon”.
- This is worth it if users make the demo look alive before judges.

Product framing:

- “Claim your $5 daemon stake.”
- “No wallet required to start watching/playing if using promo mode.”
- “Promo credits are game credits, not immediately withdrawable.”
- “Promo-credit accounts cannot withdraw until Sunday 17:00 event-local time.”

Operational notes:

- Keep promo credits separate from real deposits in accounting.
- Include promo credits in reveal bundle.
- Anti-sybil: one claim per Telegram identity/wallet/invite unless admin overrides.
- If demo load is high, cap total promo liability by invite count or campaign budget.

## Sponsor/judge line

Use this line when talking to sponsor judges:

> “I'll create a market for your project. If less than 10 projects use your SDK, at least you'll earn some money. Hedging!”

Why it works:

- It is funny and concrete.
- It shows prediction markets can create incentives around sponsor adoption.
- It invites the sponsor into the demo immediately.
- It makes the $5 signup bonus feel like activation spend, not waste.

## Suggested market examples

Use objective, resolvable markets where possible.

Good ETHGlobal-style markets:

- “Will at least 10 submitted projects mention Base?”
- “Will at least 5 submitted projects mention [Sponsor SDK]?”
- “Will total submitted projects exceed 250?”
- “Will at least 3 projects mention both [Sponsor A] and [Sponsor B]?”

Good Daemonhall/DarkBox metrics markets:

- “Will DarkBox reach 25 active daemons?”
- “Will total in-game volume exceed 1,000 USDC?”
- “Will at least 10 markets be created?”
- “Will any daemon reach +20% PnL?”

Avoid unless explicitly AdminManual:

- “best UX”
- “most innovative”
- “judges are impressed”
- “funniest demo”
- “uses X meaningfully” without a concrete definition

## Live demo flow

### Setup before judges arrive

1. Have Mini App QR/link ready.
2. Start public leaderboard/reveal countdown screen.
3. Start fake or real agent activity feed.
4. Pre-create a few sponsor-relevant markets.
5. Confirm public endpoints are safe.
6. Confirm no hidden/internal route leaks in browser devtools.
7. Have replay video ready as fallback.

### Judge interaction

1. “Open this Telegram Mini App.”
2. “Claim your $5 daemon stake.”
3. “Whisper or type a strategy.”
4. “Now your daemon is in the sealed box.”
5. Show leaderboard movement and aggregate stats.
6. Show market cards.
7. Show a sponsor-specific market.
8. Explain reveal/replay.
9. If live infra misbehaves, play the replay video and explain it is generated from the same event model/artifacts.

### What to avoid saying

Do not overclaim if pieces are still shims.

Avoid:

- “fully production decentralized bridge”
- “perfectly private against all attacks”
- “withdrawals are safe” unless signer/CVM/replay tests are done
- “real Frontier trades” unless actually wired

Safer phrasing:

- “MVP confidential deployment topology.”
- “Hidden-chain/Frontier-compatible architecture.”
- “Demo currently uses seeded/fake agents for liveness while the same APIs support real hidden-chain ingestion.”
- “Withdrawals are architected; for the demo we can keep them disabled until settlement if signer isolation is not finished.”

## Replay video goal

Fran's instruction:

- Need a replay video after a session finishes.
- Replay should show the opened box: trades, new players joining, new markets being created.
- It can be fake for the judges demo, but needs to exist as pitch collateral.

Recommended video length: 60–90 seconds.

Core shots:

1. DarkBox closed state.
2. New players/daemons joining.
3. Users whispering/typing strategies.
4. Markets appearing.
5. Agents placing trades.
6. Leaderboard shifting.
7. Volume/trade counters pulsing upward.
8. Reveal moment: box opens.
9. Timeline scrub: trades, fills, market resolutions.
10. Final accounting/replay bundle/audit stamp.

## Replay data model

Even if the first video is fake, structure the data like the real reveal bundle so the work is reusable.

Suggested event schema:

```json
{
  "runId": "demo-2026-06-13",
  "events": [
    {
      "t": 0,
      "type": "player_joined",
      "agentId": "murmur",
      "displayName": "Murmur",
      "source": "promo_invite",
      "amount": "5.00"
    },
    {
      "t": 6,
      "type": "market_created",
      "marketId": "m_base_10",
      "question": "Will at least 10 projects use Base?"
    },
    {
      "t": 14,
      "type": "trade",
      "agentId": "vesper",
      "marketId": "m_base_10",
      "side": "YES",
      "amount": "2.00",
      "price": "0.62"
    },
    {
      "t": 21,
      "type": "leaderboard_update",
      "top": [
        { "agentId": "vesper", "rank": 1, "pnl": "+12.4%" },
        { "agentId": "murmur", "rank": 2, "pnl": "+8.1%" }
      ]
    }
  ]
}
```

Useful event types:

- `player_joined`
- `invite_claimed`
- `deposit_received`
- `instruction_committed`
- `market_created`
- `split`
- `order_placed`
- `trade`
- `position_opened`
- `position_closed`
- `market_resolved`
- `leaderboard_update`
- `reveal_opened`
- `settlement_exported`

## Data sources for replay

### If real system is wired

Use:

- indexer markets/orders/fills/positions exports
- agent turn logs
- bridge deposit/promo/withdrawal accounting
- registration commitments
- resolution dossiers
- reveal bundle

### If real system is not wired

Use demo/fake sources:

- `services/agents` random/noise logs
- seeded indexer state
- a scripted JSON timeline
- manually curated sponsor markets
- fake leaderboard updates

Important: keep fake replay collateral separate from final audit truth. The pitch can use fake/demo animation, but the product promise is that final real sessions export actual replay artifacts.

## How to generate fake liveness data now

Run random agents:

```bash
cd /home/xiko/darkbox
pnpm --filter @darkbox/agents demo:random
```

Run random turns with log output:

```bash
pnpm --filter @darkbox/agents exec tsx src/cli.ts random --turns 20 --log-dir .artifacts/agent-turns
```

Run Venice if key exists:

```bash
pnpm --filter @darkbox/agents demo:venice
```

Create an activity feed from logs:

```bash
find .artifacts/agent-turns -type f -name '*.ndjson' -print
 tail -50 .artifacts/agent-turns/*.ndjson
```

There is also a helper:

```bash
scripts/agent-feed-sync.sh
```

It syncs summarized agent logs from `teebox` to the `darkbox-mic` webroot as `agent-feed.json`. Inspect before running because it assumes remote paths and repo.box access.

## Replay UI concept

A simple replay page is enough for the hackathon.

Screen sections:

- top: “DarkBox opened” title and final stats
- left: timeline scrubber
- center: market/trade animation
- right: leaderboard
- bottom: event log ticker

Animation style:

- Daemons as cards or small avatars.
- Markets as glowing boxes/cards.
- Trades as pulses/arrows into market cards.
- Leaderboard ranks slide, not jump.
- Reveal opens from dark/blurred to bright/auditable.

Stats to show:

- users joined
- markets created
- total trades
- total volume
- top PnL
- promo credits issued
- real deposits if any
- reveal bundle hash/status

## Video production plan

### Option A — Fast browser-recorded replay

1. Build a static replay HTML page that reads `replay-demo.json`.
2. Use CSS animations and JS timeline.
3. Open in browser.
4. Record with screen capture or Playwright/ffmpeg.
5. Export MP4/GIF.

Pros:

- Fast.
- Easy for frontend team.
- Reusable as reveal UI.

Cons:

- Less polished unless design pass is strong.

### Option B — Remotion video

1. Create a Remotion composition using replay JSON.
2. Render deterministic MP4.
3. Add voiceover/music if needed.

Pros:

- Better motion control.
- Deterministic video output.
- Can be polished quickly by a React-capable agent.

Cons:

- More setup if Remotion is not already in repo.

### Option C — Manual Figma/Canva style fallback

1. Create 8–10 slides/states.
2. Screen record transitions.
3. Add captions.

Pros:

- Lowest engineering risk.

Cons:

- Not reusable as product UI.

Recommendation: Option A first. Option B if there is a dedicated frontend/video agent.

## Replay script outline

Narration/caption draft:

1. “The box starts sealed.”
2. “Hackers join through Telegram and claim a $5 daemon stake.”
3. “Each player gives private strategy instructions.”
4. “Daemons trade hidden prediction markets.”
5. “Only public-safe stats leak during play: rank, PnL, activity.”
6. “New markets appear around sponsors, projects, and game metrics.”
7. “At the end, the box opens.”
8. “Trades, commitments, settlements, and agent actions become replayable.”
9. “DarkBox turns a hackathon into a live, auditable agent economy.”

## Public copy snippets

### Invite card

“Launch your daemon. Claim $5 in game credit. Whisper a strategy. Watch it trade inside the sealed box.”

### Leaderboard

“Public during play: rank, PnL, market pulse. Hidden until reveal: orders, positions, prompts, chain state.”

### Reveal

“The box opens after the session: every market, trade, commitment, and settlement artifact becomes replayable.”

### Withdrawal lock

“Promo-credit accounts unlock withdrawals after Sunday 17:00 event-local time. Real deposits and game winnings follow available-balance rules.”

## Demo honesty notes

If using fake agents:

- Call them “demo daemons” internally.
- In public pitch, focus on the product behavior, not false claims about live capital.
- If asked directly, say: “For the floor demo we can seed/fake activity; the architecture is designed so the same replay view consumes real reveal artifacts when the hidden chain is wired.”

If withdrawals are not ready:

- Say: “Withdrawals are architected around a shadow burn plus TEE signer; for the hackathon demo we can lock withdrawals until settlement/reveal.”

If CVM is not fully ready:

- Say: “The Docker topology is designed for CVM. The highest-sensitivity services are transcriber and withdrawal signer.”

## Assets needed from frontend/design

- DarkBox logo / wordmark usage.
- Daemon avatar/card style.
- Market card component.
- Leaderboard component.
- Timeline/reveal animation.
- QR/invite landing screen.
- Sponsor-market card variant.
- Final replay video export.

Existing visual assets in repo:

- `apps/telegram-miniapp/public/daemonhall-drip-head.png`
- `apps/telegram-miniapp/public/daemonhall-wordmark.png`
- `apps/telegram-miniapp/public/daemonhall-wordmark@2x.png`
- `apps/telegram-miniapp/public/daemon-gallery.js`

## Final demo checklist

Before showing judges:

- Mini App link/QR works.
- Public route leak check passes.
- Leaderboard page loads.
- Activity counters move or replay video is ready.
- Invite claim copy says $5 promo/game credit clearly.
- Withdrawal lock is visible if promo credits are shown.
- Sponsor market examples are ready.
- Replay video is accessible offline or cached.
- Dan has the short pitch memorized.

Most important fallback:

If live infra fails, show the replay video and pitch the architecture. The story is strong enough if the collateral is clear and honest.
