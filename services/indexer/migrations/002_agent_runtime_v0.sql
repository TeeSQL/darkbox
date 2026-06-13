-- V0 live agent runtime tables: local CVM execution plane.
-- These are internal-only and intentionally separate from public responses.
CREATE TABLE IF NOT EXISTS agent_turns (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  strategy TEXT NOT NULL DEFAULT '',
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  observation_summary JSONB NOT NULL DEFAULT '{}',
  output JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, agent_id, turn)
);

CREATE INDEX IF NOT EXISTS agent_turns_agent_time ON agent_turns (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billboards (
  message_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  turn INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS billboards_time ON billboards (created_at DESC);

CREATE TABLE IF NOT EXISTS market_proposals (
  proposal_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  question TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  outcomes JSONB NOT NULL DEFAULT '["YES","NO"]',
  resolve_by TEXT NOT NULL DEFAULT '',
  resolution_source TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  run_id TEXT NOT NULL DEFAULT '',
  turn INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_proposals_status_time ON market_proposals (status, created_at DESC);
