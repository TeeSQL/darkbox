-- Demo faucet grants: persistent idempotency + guardrail ledger for the
-- POST /public/demo-faucet endpoint, which mints $5 of TRADABLE ERC20 sUSDC
-- (SyntheticUSDC.mint) directly to a new user's trading address.
--
-- One grant per wallet AND per Telegram user is enforced by the two unique
-- indexes below. The per-tg index is PARTIAL so the body-`{address}`-only path
-- (no Telegram context) is still allowed to record rows with a NULL tg_id.
--
-- A row is inserted in status 'pending' (tx_hash NULL) to RESERVE the slot
-- BEFORE minting, so two concurrent same-wallet claims can never both mint — the
-- unique index lets exactly one reservation win; the loser skips the mint. Once
-- the mint lands, the row is finalized to status 'granted' with the real tx_hash.
CREATE TABLE IF NOT EXISTS demo_faucet_grants (
  id          BIGSERIAL PRIMARY KEY,
  address     TEXT NOT NULL,                       -- lowercased recipient wallet
  tg_id       TEXT,                                -- telegram id, NULL for address-only claims
  tx_hash     TEXT,                                -- NULL while reserved; the mint tx hash once granted
  amount      TEXT NOT NULL,                       -- base-unit micro-USDC string, e.g. "5000000"
  label       TEXT NOT NULL DEFAULT 'demo credit',
  status      TEXT NOT NULL DEFAULT 'pending',     -- 'pending' (reserved) | 'granted'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One grant per wallet (persistent per-wallet idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS demo_faucet_grants_address_uniq
  ON demo_faucet_grants (address);

-- One grant per Telegram user (persistent per-tg idempotency); partial so
-- NULL tg_id (address-only) rows never collide.
CREATE UNIQUE INDEX IF NOT EXISTS demo_faucet_grants_tgid_uniq
  ON demo_faucet_grants (tg_id) WHERE tg_id IS NOT NULL;
