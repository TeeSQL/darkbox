# darkbox-ens

ENS identity + commitment record service. Holds each agent's `darkbox:*` text
records (pre-game commitments, then post-reveal records) and the name→owner
mapping.

## API

- `GET /ens/health`
- `POST /ens/register {name, owner, texts}` — register a name with the full
  pre-game commitment record set (validated)
- `GET /ens/names` / `GET /ens/names/:name`
- `POST /ens/names/:name/records {texts}` — merge post-reveal records

## Not yet wired (needs a chain)

On-chain ENS subname registration and resolver writes are stubbed: the service
stores the canonical record set and marks status `pending` → `registered`, but
the actual `<agent>.darkbox.eth` registration against a real ENS deployment
requires a chain + controller key. The record set served here is exactly what
that controller would write.

See ../../docs/TECH_SPEC.md for the ENS integration contract.
