# DarkBox Telegram Mini App

Telegram Mini App experiment for DarkBox onboarding probes: browser microphone support, Blink cross-chain stablecoin deposit UX, and Dynamic / Fireblocks Flow deposit UX.

- Primary bot: `@daemonhall_bot` (menu button: **Enter Daemon Hall**)
- Legacy experiment bot: `@darkbox_mic_lab_bot` (testmic bot; currently points at `/dynamic-flow.html` for the Dynamic Flow demo)
- Public URL: `https://darkbox-mic.repo.box/`
- Dynamic Flow test URL: `https://darkbox-mic.repo.box/dynamic-flow.html`
- Runtime: static files served from repo.box VPS Caddy
- Local source: `apps/telegram-miniapp/`
- Build: `pnpm --filter @darkbox/telegram-miniapp build`

## Microphone probe

The mic panel calls `navigator.mediaDevices.getUserMedia({ audio: true })` and displays an audio-level meter locally. It does not upload, persist, or transmit recordings.

Production DarkBox should add a real transcription flow: record/upload a short whisper, call `POST /api/whispers/transcriptions`, show the draft transcript for user confirmation/editing, then commit the confirmed text into the agent instruction hash.

## Blink deposit probe

The Blink panel installs and bundles `@swype-org/deposit` and wires a Base USDC deposit request to `/api/blink/sign-payment`.

Current default route:

- Destination chain: Base `8453`
- Destination token: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Destination wallet: manually entered for the experiment

A server-side signer scaffold lives in `src/blink-signer.ts` and `src/server.ts`. It follows Blink's P-256 signer shape: validate request, create UUID idempotency key, base64url-encode the payment payload, sign the encoded payload with ECDSA P-256/SHA-256, and return `{ merchantId, payload, signature, preview }`.

Blink merchant registration is approved:

- Merchant ID: `95afb1dc-fcb0-471e-a1f7-3e1539af5f90`
- Algorithm: `ECDSA_P256_SHA256`
- Private key: ignored local secret, loaded through `BLINK_MERCHANT_PRIVATE_KEY_PATH`

Do not put the private key in client code or public env vars. For a real DarkBox deposit flow, replace the manual destination address with either the user's embedded wallet or a DarkBox deposit-intent/bridge address once attribution is finalized.

## Dynamic Flow deposit probe

The separate Dynamic Flow lab lives at `/dynamic-flow.html` so it can be opened from the legacy `@darkbox_mic_lab_bot` without touching the main Daemon Hall Mini App bot.

The page calls `POST /api/dynamic-flow/intents` to create a short-lived DarkBox deposit intent and prepare Dynamic Flow checkout/transaction payloads.

Current default route:

- Destination chain: Base `8453`
- Destination token: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Destination wallet: DarkBoxBridge `0x55E84818FCEDc3E892A22b46715Ee2B4A947E138`
- Memo: includes `depositIntentId`, `gameId`, `beneficiary`, and `depositRef`

Live Dynamic Flow config is wired through the server env:

- `DYNAMIC_ENVIRONMENT_ID`: Dynamic environment id
- `DYNAMIC_FLOW_CHECKOUT_ID`: reusable Flow deposit checkout id
- `DYNAMIC_API_TOKEN`: optional for transaction creation; required only for checkout/admin management

If the environment id or checkout id are missing, the endpoint returns a dry-run payload instead of calling Dynamic.

Bot token is intentionally ignored under `.secrets/telegram-bot-token`.
