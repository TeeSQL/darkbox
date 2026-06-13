# @darkbox/transcriber — private whisper transcription

A **private/confidential** service (hidden/TEE plane). It turns a player's voice
note into a draft transcript, lets them confirm/edit it, and returns the
instruction commitment hash. Reachable **only** from the gateway over an internal
network — never from the public internet.

## Privacy & retention

- Raw audio and draft transcripts are the strategy preimage → sensitive.
- Raw audio is dropped immediately on `confirm`, and any draft is purged
  `RETENTION_MS` (default 15 min) after creation by a periodic sweep.
- Responses never include raw audio. Only hashes + the confirmed transcript
  cross the boundary; the gateway commits `instructionHash`.

## STT backends (`STT_MODE`)

- `stub` (default): deterministic, no network. Returns a clearly-labelled
  placeholder so the stack runs offline/CI. The gateway also has a typed-text
  fallback, so STT is never the demo critical path.
- `http`: POST audio to an OpenAI-compatible `/audio/transcriptions` endpoint
  (`STT_URL`, `STT_API_KEY`, `STT_MODEL`) — e.g. a self-hosted whisper in the TEE.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | liveness |
| POST | `/api/whispers/transcriptions` | audio (`audioBase64` \| `audioUrl` \| `telegramFileId`) → draft |
| GET  | `/api/whispers/transcriptions/:id` | poll draft (no raw audio) |
| POST | `/api/whispers/transcriptions/:id/confirm` | confirm/edit → instruction hash |

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8095` | |
| `STT_MODE` | `stub` | `stub` \| `http` |
| `STT_URL` / `STT_API_KEY` / `STT_MODEL` | _(unset)_ / _(unset)_ / `whisper-1` | http mode |
| `TELEGRAM_FILE_BASE_URL` | _(unset)_ | resolve `telegramFileId` → URL |
| `MAX_AUDIO_BYTES` | `5000000` | upload cap |
| `MAX_TRANSCRIPT_CHARS` | `2000` | confirmed-transcript cap |
| `RETENTION_MS` | `900000` | raw audio / draft purge window |

## Run

```bash
pnpm --filter @darkbox/transcriber typecheck
pnpm --filter @darkbox/transcriber test
pnpm --filter @darkbox/transcriber dev   # STT_MODE=stub by default
```
