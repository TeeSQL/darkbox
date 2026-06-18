# /goal: Bring DarkBox indexer PnL confidence to production-grade

You are Codex running in `/home/xiko/darkbox` with `--yolo`.

Context:
- Fran asked whether a user with positions in 20 markets would get accurate PnL. Current honest answer is no / low confidence.
- Existing branch/commit: `dc33bdd feat(indexer): add latest trade marks for PnL`, pushed to `origin/feat/indexer-latest-trade-pnl`.
- Current live issue: market latest-price marks exist, but account attribution is broken/incomplete. Live `agents` table was empty and existing orders had `shadow_account=null`, so user/agent positions remain zero.
- Do NOT expose hidden orderbook/positions on public APIs. Public can show approved PnL/rank/market data only.

Objective:
Bring confidence as close to 100% as possible that the indexer can show accurate realized + unrealized PnL for one user/agent across 20 markets.

Non-negotiable acceptance test:
Create a deterministic fixture/integration test that simulates at least:
- 1 user/agent with deterministic `owner_address`, `agent_id`, `shadow_account`
- 20 distinct markets
- orders/fills across all 20 markets
- at least both YES and NO outcomes represented
- maker-style and taker-style fills if the current event model supports them; if not, explicitly document the contract event limitation and add the closest valid fixture
- cancels/requotes/transfers/split/join/redeem coverage if supported by current reducers; if not implemented, add failing TODO tests or explicit documented blockers
- known hand-calculated expected values for quantity, cost basis, latest mark, realized PnL, unrealized PnL, total PnL, equity
- snapshot + public leaderboard/output check equals expected values

What to fix:
1. Account attribution
   - Ensure orders/fills/positions can deterministically map to `shadow_account`/`agent_id`.
   - Fix `resolveOwnerToShadowAccount` or agent registration/fixture setup as needed.
   - If current live feeder uses the Anvil deployer without registering an agent, create a clear repo-side fix or runbook so live data is not orphaned.

2. Position accounting
   - Maker deposits should not blindly become held positions unless that is truly correct for Frontier semantics.
   - Fills should update positions/cost basis/realized PnL according to actual economic ownership.
   - Taker fills must update taker positions, or if events do not identify taker sufficiently, document contract/indexer event gap and create a concrete required event/schema change.
   - Cancels/requotes should not corrupt position quantities/cost basis.

3. Latest marks
   - Keep latest market prices from real Frontier fill events.
   - Verify mark price math against Frontier geometry well enough for test confidence.

4. Public/internal API boundary
   - Public leaderboard should show only approved fields. Consider removing `equity`/`netDeposits` from public if hidden-state privacy says they leak too much; document decision.
   - Internal APIs can expose full accounting for debugging.

5. Tests/gates
   - Run at least `pnpm --filter @darkbox/indexer typecheck` and `pnpm --filter @darkbox/indexer test`.
   - Add targeted tests rather than only changing code.
   - The final report must include exact commands run and confidence assessment.

Deliverables:
- Code changes in `/home/xiko/darkbox`.
- Tests proving 20-market user PnL accuracy or a precise blocker if impossible without contract event changes.
- A short written report in the final Codex output:
  - what changed
  - what is now proven
  - what remains impossible/blocked
  - confidence level and why

Important:
- Do not touch unrelated miniapp/admin dirty changes unless required for API shape.
- Prefer a new branch if committing/pushing.
- Do not claim 100% unless the 20-market deterministic test passes and there are no known accounting holes.
