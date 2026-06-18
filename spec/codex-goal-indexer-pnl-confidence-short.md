/goal Bring DarkBox indexer PnL confidence to production-grade.

Repo: /home/xiko/darkbox. Work only on indexer/accounting unless unavoidable.

Problem: current latest-price patch marks markets but user PnL is not trustworthy. Live orders/fills can be orphaned from shadow_account/agent_id. Fran asked: if a user has positions in 20 markets, can the indexer show PnL accurately? Your mission is to make the answer yes, or prove the exact contract/event blocker.

Acceptance test is mandatory:
- deterministic fixture with 1 user/agent: owner_address, agent_id, shadow_account
- 20 markets
- trades/positions across all 20 markets, both YES and NO outcomes
- known expected quantity, cost basis, latest mark, realized PnL, unrealized PnL, total PnL, equity
- snapshot and leaderboard output must equal expected values
- include maker/taker/cancel/requote/split/join/redeem coverage where supported; if impossible due current events, add explicit failing/TODO tests or document blocker precisely

Fix areas:
1. deterministic order/fill/position attribution to shadow_account/agent_id
2. correct position accounting; do not treat maker deposits as holdings unless economically correct
3. taker fills update taker positions, or document required event/schema change if taker identity is absent
4. latest market marks from real Frontier fill events using correct tick math
5. public API remains sanitized; remove equity/netDeposits if they violate privacy, or document why retained

Run gates:
- pnpm --filter @darkbox/indexer typecheck
- pnpm --filter @darkbox/indexer test

Deliver final report with: code changed, tests added, commands run, confidence level, and remaining blockers. Do not claim 100% unless the 20-market deterministic test passes and no accounting holes remain.
