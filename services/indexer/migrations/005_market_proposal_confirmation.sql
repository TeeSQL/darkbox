-- Open market proposal + DarkBox Telegram/group confirmation audit fields.
ALTER TABLE market_proposals
  ALTER COLUMN agent_id DROP NOT NULL,
  ALTER COLUMN agent_id SET DEFAULT '',
  ADD COLUMN IF NOT EXISTS proposer_kind TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS proposer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS proposer_telegram_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS proposer_telegram_username TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS proposer_role TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confirmer_telegram_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confirmer_telegram_username TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_telegram_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resolver_type TEXT NOT NULL DEFAULT 'AdminManual',
  ADD COLUMN IF NOT EXISTS close_time BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS market_proposal_audit (
  id BIGSERIAL PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES market_proposals(proposal_id) ON DELETE CASCADE,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  actor_telegram_id TEXT NOT NULL DEFAULT '',
  actor_telegram_username TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  review_chat_id TEXT NOT NULL DEFAULT '',
  review_message_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_proposal_audit_proposal_time
  ON market_proposal_audit (proposal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS market_proposals_confirmed_ready
  ON market_proposals (status, close_time);
