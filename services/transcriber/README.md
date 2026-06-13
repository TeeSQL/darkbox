# darkbox-transcriber

TEE/CVM service for transcribing user “whispers” into confirmed agent instructions.

## Placement

- Lives on the private side, not in the public frontend or Telegram Mini App.
- Production/hackathon target: Phala CVM unless a better TEE path is chosen.
- Local dev can run as a normal Docker service on `hidden_net`, but keep the API/container shape compatible with Phala deployment.
- Public clients should reach it only through narrow proxy routes for upload/status/confirm.

## API shape

- `POST /api/whispers/transcriptions` — audio upload or `{ telegramFileId | audioUrl }`
- `GET /api/whispers/transcriptions/:whisperId` — status/result
- `POST /api/whispers/transcriptions/:whisperId/confirm` — user-confirmed transcript -> instruction commitment payload

## Privacy rules

- Raw audio and draft transcripts are private strategy data.
- Provider transcript output is a draft; user must confirm/edit before commitment.
- Transcript text is untrusted user input and cannot alter infrastructure/game policy.
- Keep provider credentials and retention storage inside the TEE/private boundary.
