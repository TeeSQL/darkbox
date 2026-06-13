# Wiring the Mini App to the gateway (`gatewayClient.ts`)

This replaces the **mocked data** in `public/flow.js` with real calls to the
DarkBox gateway (`/api/*`) and indexer (`/public/*`). **No visual/ritual UI
changes** — only the data sources behind the existing screens.

The client (`src/gatewayClient.ts`) is self-contained (browser `fetch`, zero
deps) and fully tested. Point it at a local stack now, the deployed services
later.

## 1. Instantiate (once)

```ts
import { createGatewayClient } from "./gatewayClient.js";

const gateway = createGatewayClient({
  gatewayBaseUrl: import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8090",
  publicBaseUrl:  import.meta.env.VITE_PUBLIC_URL  ?? "http://localhost:8080/public",
  // initData defaults to window.Telegram.WebApp.initData; for local dev set:
  // devTelegramId: "demo-123"   // gateway must run with ALLOW_INSECURE_DEV_AUTH=true
});
```

`flow.js` is plain JS — either import the built client or expose it on `window`
from `client.ts` (`window.DarkboxGateway = createGatewayClient({...})`).

## 2. Map the mock points

| `flow.js` mock today | Replace with | Notes |
|----------------------|--------------|-------|
| **daemon balance / pnl** (`daemonBalanceEl` / `daemonPnlEl`, the `selectedStake + (h % 900)/100` fake near the stake/wait render) | `const s = await gateway.selfStatus();` → show `s.withdrawableAvailableBalance` (or the player's row from `gateway.leaderboard()` for live PnL) | self-status also gives `withdrawalLock` (promo lock) + `fundingStatus` |
| **leaderboard rows** (`leaderboardRowsEl`, hash-generated rows) | `const rows = await gateway.leaderboard();` then render the same row markup | public/indexer data; rank/PnL/ENS only |
| **whisper "type the final whisper"** (mic→typed, never committed) | `createWhisper({ text }) → confirmWhisper(id, text) → register({ agentName, instructionHash })` | or one call: `gateway.runJoinFlow({ agentName, whisperText })` |
| **no $5 claim today** | on entry: `const s = await gateway.selfStatus(); if (!s.enteredViaInvite) await gateway.claimInvite();` | idempotent — safe to call again; shows the promo credit + Sunday lock |

## 3. The whole join flow in one call

For the seal-the-pact → daemon-reveal transition:

```js
const result = await gateway.runJoinFlow({
  agentName: chosenDaemonName,
  whisperText: whisperInput.value,
});
// result.claim      -> $5 promo credit (or null if already claimed)
// result.confirmed  -> { instructionHash } committed
// result.after      -> refreshed self-status (balance, lock, registered)
```

It runs: **self-status → claim (if not entered) → whisper → confirm → register →
self-status refresh** — exactly the demo flow.

## 4. Keep the demo unbreakable (graceful fallback)

The gateway may not be deployed during a given demo. Wrap calls so the existing
mock stays as a fallback — the UI never breaks:

```js
async function balanceText() {
  try { return (await gateway.selfStatus()).withdrawableAvailableBalance ?? mockBalance(); }
  catch { return mockBalance(); }   // keep current mock on any error
}
```

This lets you flip `VITE_GATEWAY_URL` on/off without touching the screens.

## 5. Local stack to point at

```bash
# gateway (dev auth) + transcriber
ALLOW_INSECURE_DEV_AUTH=true TRANSCRIBER_URL=http://localhost:8095 \
  pnpm --filter @darkbox/gateway dev &
STT_MODE=stub PORT=8095 pnpm --filter @darkbox/transcriber dev &
# indexer for /public/leaderboard
pnpm --filter @darkbox/indexer dev &
```

Then `VITE_GATEWAY_URL=http://localhost:8090` and a `devTelegramId`.

> Note: the gateway/indexer live on `feat/deposits-withdrawals`; this client lives
> in the miniapp on `main`. They meet at the HTTP boundary (configurable URL), so
> no branch coupling is needed — they integrate when those branches merge.
