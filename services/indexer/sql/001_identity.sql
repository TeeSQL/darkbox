-- Off-chain identity registry.
-- Keyed by shadow_account (the only attribute every participant has).
-- daemon_name is generated once at insert and never updated; it is the
-- name shown on public leaderboards. telegram_* and owner_address are
-- null for spawned agents.

CREATE TABLE IF NOT EXISTS identity (
  shadow_account   text        PRIMARY KEY,
  daemon_name      text        NOT NULL UNIQUE,
  source           text        NOT NULL CHECK (source IN ('human', 'spawned')),
  agent_id         text,
  owner_address    text,
  telegram_user_id bigint,
  telegram_handle  text,
  ens_name         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Spawned agents have no telegram, so the unique mapping only applies to
-- the rows that do carry one.
CREATE UNIQUE INDEX IF NOT EXISTS identity_telegram_user_id_key
  ON identity (telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS identity_agent_id_idx
  ON identity (agent_id)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS identity_owner_address_idx
  ON identity (owner_address)
  WHERE owner_address IS NOT NULL;
