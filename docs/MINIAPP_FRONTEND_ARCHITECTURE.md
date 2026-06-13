# Telegram Mini App — Frontend Architecture & Migration Plan

**Status:** Proposed (awaiting sign-off)
**Author:** drafted from frontend audit, 2026-06-13
**Scope:** `apps/telegram-miniapp`
**Goal:** Refactor the miniapp to a componentized, DRY, typed architecture that runs
identically on Telegram **and** web, keeps the existing three.js reveal, and exposes a
clean data layer to integrate the live backend.

---

## 1. Why we're doing this

We want to integrate the real backend (gateway + indexer). Before that, the frontend
needs an architecture that gives BE integration a single, typed seam — instead of
threading `fetch` calls through procedural DOM code that is also duplicated per entry
point.

### Current state (audit findings)

| Problem | Detail |
|---|---|
| No component model | `public/flow.js` is ~750 lines of procedural code: 45 `querySelector` calls, module-global mutable state (`let listening`, `selectedDaemon`, …), UI built via `innerHTML` string templates. |
| Markup duplication | `index.html` and `web.html` are near-identical apps sharing **72** CSS classes, hand-maintained in parallel. |
| Mixed module systems | Typed TS in `src/` (Vite-processed) vs large **untyped** JS shipped verbatim from `public/` (`flow.js`, `admin.js`) — the actually-shipped UI has no type safety. |
| Mock-only UI | `flow.js` has **zero** network calls; markets/leaderboard/receipts are deterministic fake data. |
| Dead code | `src/client.ts` (446 lines, added in `776caa9`, never reused) targets an old `/agent-feed.json` shape and is referenced by nothing. **Superseded by `gatewayClient.ts`.** |
| Manual cache-busting | Hand-rolled `?v=20260613-...` query strings that already drift between files; Vite content-hashing would handle this. |
| No tests on shipped code | Only `gatewayClient.test.ts` exists — and it covers a module the UI doesn't yet load. |

### Key asset we already have

`src/gatewayClient.ts` is **not** dead code — it is a correct, zero-dep, typed,
**tested** client that matches the live gateway routes (auth via Telegram `initData`).
It is simply not wired into the UI yet. The refactor **promotes and extends** it rather
than rewriting.

---

## 2. Technology decision

**Preact + TypeScript + Vite + Preact Signals**, with a thin platform adapter.

| Decision | Rationale |
|---|---|
| **Preact** (~4KB) | Real components + JSX with a tiny runtime — matters in the Telegram in-app webview (bundle size / cold start). React (~45KB) is overkill; Preact has a deeper ecosystem than Solid and a trivial escape hatch. |
| **One bundle, both targets** | "Miniapp vs web" is **not** an architecture split — both are the same webview running the same code. The *only* difference is whether `window.Telegram.WebApp` exists. That is handled by one platform adapter, not two apps. |
| **three.js stays** | three is framework-agnostic. The existing reveal becomes a `<DaemonReveal>` component owning a `<canvas>` via a ref + `useEffect` render loop. **No rewrite of WebGL/shader code.** |
| **Preact Signals** | Replaces scattered module-global `let`s with one reactive store. A backend update flows to one place; UI re-renders automatically (no manual `renderMarkets()` calls). |
| **Vite (keep)** | `@preact/preset-vite` is first-class; keeps the existing build. Content-hashing removes manual `?v=` busting. |

---

## 3. Target structure

```
apps/telegram-miniapp/
  index.html                 # single entry (web.html removed)
  src/
    main.tsx                 # mounts <App/>
    app.tsx                  # router/shell: Hall, DynamicFlow, Admin views
    platform/
      telegram.ts            # THE platform seam: isTelegram(), getInitData(),
                             #   theme, haptics — web/dev fallbacks here
    api/
      gateway.ts             # authed /api/* client (promoted gatewayClient.ts + deposits/withdrawals)
      indexer.ts             # NEW — public /public/* reads (markets, leaderboard, game, activity)
      types.ts               # response types mirrored from gateway zod schemas + indexer rows
    state/
      store.ts               # Signals store: `public` slice (live) + `self` slice (authed)
    components/
      DaemonReveal.tsx       # wraps existing three.js reveal
      MicComposer.tsx        # whisper flow: create -> poll draft_ready -> confirm
      Markets.tsx
      Leaderboard.tsx
      SealedTerminal.tsx
      AdminConsole.tsx
    views/
      Hall.tsx               # main screen (replaces index.html + web.html bodies)
      DynamicFlow.tsx
    server.ts                # UNCHANGED role: static host + Telegram webhook +
                             #   Blink/Dynamic payment signing proxy
```

### Two backends, two clients (mirrors the auth boundary)

**Gateway (Fastify)** — authenticated, Telegram `initData` header on every call:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/self/status` | Player's own state (identity, funding, registration, withdrawal lock) |
| POST | `/api/invites/claim` | Claim invite → funding credit + lock |
| POST | `/api/registrations` | Register agent |
| POST | `/api/whispers/transcriptions` | Create whisper → transcriber → `draft_ready` |
| GET | `/api/whispers/transcriptions/:id` | Poll whisper |
| POST | `/api/whispers/transcriptions/:id/confirm` | Seal commitment |
| POST | `/api/deposit-intents` | Create deposit intent |
| GET | `/api/deposits/:depositOpId` | Deposit reconciliation status |
| GET | `/api/withdrawable/:owner` | Withdrawable balance |
| POST | `/api/withdrawals/commands` | Submit shadow-burn withdrawal |
| GET | `/api/withdrawals/:withdrawalId` | Withdrawal status |

`gatewayClient.ts` already covers: `selfStatus`, `claimInvite`, `createWhisper`,
`getWhisper`, `confirmWhisper`, `register`, `leaderboard`, `runJoinFlow`.
**To add:** `createDepositIntent`, `getDeposit`, `getWithdrawable`, `submitWithdrawal`,
`getWithdrawal`.

**Indexer (Fastify)** — public, no auth (`stripForbidden` guards key leakage). This is
the **real data that `flow.js` currently fakes**:

| Route | Returns |
|---|---|
| `/public/game` | Global stats: active markets/agents, total trades, volume |
| `/public/markets`, `/public/markets/:id` | Market rows |
| `/public/leaderboard` | `{agentId, ensName, rank, pnl, pnlPct, equity, netDeposits}` |
| `/public/activity` | Activity feed |
| `/public/timeseries` (alias `/datapoints`) | Charts |
| `/public/agents/:id/status`, `/public/reveal/status` | Agent + reveal state |

> **Note:** the browser calls gateway and indexer **directly** (the gateway needs the
> browser's `initData` anyway). `src/server.ts` must **not** re-proxy them; it stays a
> static host plus the payment/Telegram-webhook proxy it already is.

### State split

- **`public` slice** — polled indexer data (markets, leaderboard, game, activity). Shared, cacheable, no auth.
- **`self` slice** — authenticated gateway state (self/status, whisper drafts, funding). Per-user.

Keeping these separate in the store mirrors the backend auth boundary and keeps polling
concerns isolated.

---

## 4. Migration path (incremental, nothing breaks mid-flight)

Old files stay in place until the new path renders, then are deleted.

1. **Tooling** — add `@preact/preset-vite` + `@preact/signals`; `main.tsx` mounts an empty `<App>`.
2. **Foundations first** — `platform/telegram.ts`, `api/gateway.ts` (promote + extend `gatewayClient.ts`), `api/indexer.ts`, `api/types.ts`. Typed and unit-tested before any view depends on them.
3. **three.js wrapper** — port `daemon-reveal.ts` into `<DaemonReveal>` (highest-value; proves the canvas lifecycle pattern).
4. **Views screen-by-screen** — port from `flow.js` into components, deleting procedural equivalents as each lands. `<MicComposer>` (the whisper create→poll→confirm flow) is the strongest validation of Signals + components.
5. **Cleanup** — delete `src/client.ts`, `web.html`, `public/flow.js`, `public/admin.js`, and the manual `?v=` cache-busting once nothing references them. Collapse to one entry in `vite.config.ts`.

### Definition of done
- One entry point; no duplicated markup.
- All UI code is typed TS in `src/`; nothing untyped in `public/` except static assets.
- All backend access flows through `api/gateway.ts` / `api/indexer.ts`; no `fetch` in components.
- three.js reveal renders via `<DaemonReveal>`, unchanged visually.
- Runs in Telegram and in a plain browser via the platform adapter.
- `flow.js` mock generators replaced by live indexer reads.

---

## 5. Open questions for sign-off

1. Confirm the browser calls gateway/indexer directly (CORS + `initData` header) vs. routing through `server.ts`. Direct is assumed here.
2. Polling cadence for the `public` slice (markets/leaderboard) — interval vs. on-view-focus.
3. Web (non-Telegram) auth: rely on the existing `devTelegramId` fallback in `gatewayClient.ts`, or a separate web auth path?
