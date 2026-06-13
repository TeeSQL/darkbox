# DarkBox frontend API handover for Kristel / Nicolai

This package is for frontend and Mini App integration only.

Out of scope here:
- hidden/internal indexer endpoints
- agent runtime APIs
- signer/admin/reconciliation endpoints
- raw transcript/audio access
- direct contract admin operations

The frontend boundary is intentionally narrow:
- public game discovery and spectator data come from the indexer public API
- authenticated player-specific state comes from public-safe bridge/transcriber/registration surfaces
- hidden trading state, orderbooks, fills, balances, prompts, and internal logs stay private until reveal

## Base surfaces

Expected public-facing services:
- `darkbox-indexer` for spectator/public game data
- `darkbox-bridge` for deposit, invite, and withdrawal flows
- `darkbox-transcriber` behind a narrow proxy for whisper upload/status/confirm
- optional frontend gateway/BFF that unifies these routes for the web app and Telegram Mini App

Suggested frontend base paths:
- `/public/*` for spectator data from indexer
- `/api/*` for authenticated player actions/status

## Public spectator endpoints

### `GET /public/health`
Health check for the public indexer.

Example response:
```json
{
  "ok": true
}
```

### `GET /public/game`
Returns the public game lifecycle state.

Used for:
- current phase/status
- countdowns
- registration open/frozen/live/reveal UX
- reveal gating

Example response:
```json
{
  "gameId": "ethglobal-cannes-2026",
  "title": "DarkBox Cannes",
  "status": "live",
  "registrationFreezeAt": "2026-06-14T09:00:00.000Z",
  "startsAt": "2026-06-14T10:00:00.000Z",
  "endsAt": "2026-06-15T16:00:00.000Z",
  "revealStatus": "pending",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `GET /public/leaderboard`
Returns public-safe agent ranking only.

May include:
- agent id
- display name / ENS name
- public PnL
- rank
- timestamps

Must not include:
- balances
- positions
- per-market breakdowns
- hidden trade history

Example response:
```json
[
  {
    "agentId": "agent_raven",
    "displayName": "Raven",
    "ensName": "raven.darkbox.eth",
    "pnl": 12.4,
    "rank": 1,
    "updatedAt": "2026-06-13T08:00:00.000Z"
  }
]
```

### `GET /public/markets`
Returns the public market list and metadata.

Used for:
- market cards
- question list
- status chips
- resolve/reveal navigation

Example response:
```json
[
  {
    "marketId": "market_winner",
    "question": "Will Project X win the hackathon?",
    "status": "live",
    "category": "hackathon",
    "resolverType": "AdminManual",
    "closesAt": "2026-06-15T15:00:00.000Z",
    "updatedAt": "2026-06-13T08:00:00.000Z"
  }
]
```

### `GET /public/markets/{marketId}`
Returns one market's public metadata.

Example response:
```json
{
  "marketId": "market_winner",
  "question": "Will Project X win the hackathon?",
  "status": "live",
  "category": "hackathon",
  "resolverType": "AdminManual",
  "description": "Canonical winner market",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `GET /public/activity`
Returns aggregate activity only.

Used for:
- proof-of-life stats
- hero counters
- "market is alive" UI

Example response:
```json
{
  "activeAgents": 18,
  "activeMarkets": 7,
  "totalTrades": 143,
  "totalVolume": 5820,
  "positionsOpened": 66,
  "positionsClosed": 31,
  "totalDeposits": 940,
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `GET /public/agents/{agentId}/status`
Public-safe single-agent card.

This is still spectator-safe, not private self state.

Example response:
```json
{
  "agentId": "agent_raven",
  "displayName": "Raven",
  "ensName": "raven.darkbox.eth",
  "rank": 1,
  "pnl": 12.4,
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `GET /public/reveal/status`
Returns reveal state for countdowns and unlock UX.

Example response:
```json
{
  "revealStatus": "pending",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

## Authenticated player endpoints

These are public-safe, user-scoped endpoints for the web app / Telegram Mini App.
Frontend should assume Telegram auth and/or wallet auth will sit in front of these routes.

### `GET /api/self/status`
Returns the authenticated player's own safe status.

Should include only what the player needs:
- registration status
- whether they entered via promo invite
- deposit/funding status
- withdrawable available balance
- agent id
- instruction commitment hash
- withdrawal lock state

Must not leak hidden market positions or raw internal trading state.

Example response:
```json
{
  "owner": "0x1234...abcd",
  "telegramId": "81234123",
  "agentId": "agent_raven",
  "registrationStatus": "registered",
  "fundingStatus": "funded",
  "enteredViaInvite": true,
  "inviteId": "invite_cannes_001",
  "withdrawableAvailableBalance": "3.25",
  "instructionCommitmentHash": "0x9f2d4d7f6f1a...",
  "withdrawalLock": {
    "locked": true,
    "reason": "promo_bonus_unlock",
    "unlockAt": "2026-06-15T17:00:00.000Z"
  },
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

## Invite flow

### `POST /api/invites/claim`
Claims a disposable invite / signup bonus.

Expected behavior:
- one claim per eligible wallet/Telegram identity unless admin override
- creates or resolves owner -> shadow account mapping
- marks promo funding source
- applies Sunday unlock rule for withdrawals

Example request:
```json
{
  "inviteCode": "CANNES-DEMON-7Q2K",
  "owner": "0x1234...abcd",
  "telegramInitData": "..."
}
```

Example response:
```json
{
  "inviteId": "invite_cannes_001",
  "claimStatus": "claimed",
  "agentFundingCredit": {
    "currency": "USDC",
    "amount": "5.00",
    "type": "promo_shadow"
  },
  "withdrawalLock": {
    "locked": true,
    "unlockAt": "2026-06-15T17:00:00.000Z"
  },
  "shadowAccount": "0x7db2...c1fe",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

## Whisper transcription flow

Raw audio and draft transcripts are private. Frontend should treat this as a narrow upload/review flow only.

### `POST /api/whispers/transcriptions`
Uploads audio or references a Telegram voice note.

Supported shapes:
- multipart file upload
- JSON body with `telegramFileId`
- optional `audioUrl` for controlled server-side fetches

Example JSON request:
```json
{
  "telegramFileId": "AwACAg...",
  "languageHint": "en"
}
```

Example response:
```json
{
  "whisperId": "whsp_01jxz4...",
  "status": "draft_ready",
  "transcript": "Buy NO on projects using only AI wrappers.",
  "language": "en",
  "durationMs": 8420,
  "audioHash": "0xaaaabbbbcccc",
  "transcriptHash": "0x111122223333",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `GET /api/whispers/transcriptions/{whisperId}`
Polls status/result for the uploaded whisper.

Example response:
```json
{
  "whisperId": "whsp_01jxz4...",
  "status": "draft_ready",
  "transcript": "Buy NO on projects using only AI wrappers.",
  "language": "en",
  "durationMs": 8420,
  "audioHash": "0xaaaabbbbcccc",
  "transcriptHash": "0x111122223333",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `POST /api/whispers/transcriptions/{whisperId}/confirm`
Confirms or edits the final transcript and returns commitment payload material.

Example request:
```json
{
  "finalTranscript": "Buy NO on thin wrapper projects. Prefer infra teams with real usage.",
  "commitmentSalt": "0x4b3f...9aa1"
}
```

Example response:
```json
{
  "whisperId": "whsp_01jxz4...",
  "status": "confirmed",
  "instructionHash": "0x8b3b0d3b8b...",
  "commitmentPayload": {
    "instructionHash": "0x8b3b0d3b8b...",
    "transcriptHash": "0x444455556666"
  },
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

## Deposit flow

### `POST /api/deposit-intents`
Optional helper route for frontend-composed deposit flows.

Use cases:
- create a deposit session
- attribute a deposit to a beneficiary/agent
- prebuild deposit instructions for Base / Blink / future providers

Example request:
```json
{
  "owner": "0x1234...abcd",
  "agentId": "agent_raven",
  "amount": "25.00",
  "chainId": 8453,
  "token": "USDC"
}
```

Example response:
```json
{
  "depositOpId": "dep_01jxz5...",
  "status": "intent_created",
  "chainId": 8453,
  "token": "USDC",
  "amount": "25.00",
  "beneficiary": "0x1234...abcd",
  "depositAddress": "0xabcd...1234",
  "expiresAt": "2026-06-13T08:20:00.000Z"
}
```

### `GET /api/deposits/{depositOpId}`
Returns deposit detection/reconciliation status.

Example response:
```json
{
  "depositOpId": "dep_01jxz5...",
  "status": "shadow_minted",
  "chainId": 8453,
  "txHash": "0xabc123...",
  "amount": "25.00",
  "shadowAccount": "0x7db2...c1fe",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

## Registration / commitment flow

### `POST /api/registrations`
Registers or updates the player's agent commitment before freeze.

Should bind:
- agent display name
- ENS name if used
- shadow account / owner mapping
- instruction commitment hash
- reveal salt hash
- runtime hash if exposed in UX

Example request:
```json
{
  "agentName": "Raven",
  "ensName": "raven.darkbox.eth",
  "instructionHash": "0x8b3b0d3b8b...",
  "revealSaltHash": "0x2cf0f8...",
  "runtimeHash": "0x7fa91b..."
}
```

Example response:
```json
{
  "registrationStatus": "registered",
  "agentId": "agent_raven",
  "commitmentRecorded": true,
  "instructionHash": "0x8b3b0d3b8b...",
  "registeredAt": "2026-06-13T08:00:00.000Z"
}
```

## Withdrawal flow

### `GET /api/withdrawable/{owner}`
Returns withdrawable available balance only.

Example response:
```json
{
  "owner": "0x1234...abcd",
  "withdrawableAvailableBalance": "3.25",
  "currency": "USDC",
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `POST /api/withdrawals/commands`
Submits a user-signed withdrawal command.

Expected behavior:
- validates EIP-712 user command
- checks withdrawable available balance
- triggers shadow burn/lock
- returns status and eventual service authorization when ready

Example request:
```json
{
  "owner": "0x1234...abcd",
  "shadowAccount": "0x7db2...c1fe",
  "amount": "3.00",
  "recipient": "0x1234...abcd",
  "destinationChainId": 8453,
  "destinationBridge": "0xbridge...",
  "nonce": 7,
  "deadline": 1781328000,
  "signature": "0xdeadbeef..."
}
```

Example response:
```json
{
  "withdrawalId": "wd_01jxz7...",
  "status": "shadow_burn_submitted",
  "amount": "3.00",
  "recipient": "0x1234...abcd",
  "destinationChainId": 8453,
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

### `GET /api/withdrawals/{withdrawalId}`
Returns withdrawal lifecycle status.

Expected statuses include:
- `requested`
- `user_signed`
- `shadow_burn_submitted`
- `shadow_burned`
- `service_signed`
- `submitted_public_withdrawal`
- `withdrawn`

Example response:
```json
{
  "withdrawalId": "wd_01jxz7...",
  "status": "service_signed",
  "amount": "3.00",
  "recipient": "0x1234...abcd",
  "destinationChainId": 8453,
  "authorization": {
    "deadline": 1781328000,
    "signature": "0xcafe..."
  },
  "updatedAt": "2026-06-13T08:00:00.000Z"
}
```

## Hidden / internal endpoints explicitly out of scope

Do not build the frontend against these:
- `/internal/*`
- `/bridge/admin/*`
- signer service endpoints
- raw orderbooks/fills/positions before reveal
- raw whisper audio/transcript retrieval
- reveal export internals

## Frontend implementation notes

- The Telegram Mini App should use the same API boundary as the web app.
- Treat `GET /api/self/status` as the main authenticated hydration endpoint.
- Treat whisper transcription as a two-step review flow, not one-shot commit.
- Do not assume live hidden-market details will ever be available pre-reveal.
- If desktop/web ships alongside Telegram, support a second auth path such as wallet signature.
- Promo-invite users have a withdrawal lock until the configured Sunday unlock time; surface this clearly in UI.

## Current repo reality

Already present in repo/specs:
- public indexer routes for game, markets, leaderboard, activity, public agent status, reveal status
- transcriber API shape for upload/status/confirm
- bridge API shape for deposit intent, deposit status, withdrawable balance, withdrawal command, withdrawal status
- contract artifacts for bridge registration/deposit/withdrawal primitives

Still implementation-dependent / to be finalized by backend:
- exact auth middleware and token format
- final self-status response schema
- exact registration endpoint path and wire format
- invite claim endpoint wire format
- final enum spelling for lifecycle statuses
- final deposit provider path if Blink remains in flow
