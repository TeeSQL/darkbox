# darkbox-bridge

Deposit, shadow-mint, withdrawal, and emergency-exit coordinator.

Responsibilities:

- detect direct ETH sends, direct USDC transfers, explicit deposit calls, and provider/composed funding events
- resolve onchain owner wallets to shadow accounts
- submit idempotent shadow mints to the shadow EVM after confirmed public deposits
- expose public deposit status, account mapping, withdrawable balance, and withdrawal command APIs
- validate user-signed withdrawal commands
- force shadow-EVM burn/transfer of withdrawable available balance before public withdrawal
- request signing-service authorization after shadow burn confirmation
- keep privileged reconciliation endpoints internal only
- support multisig emergency withdrawals

## Implemented

A real coordinator (`src/coordinator.ts`) drives the deposit/withdrawal
lifecycle against the indexer:

- `POST /bridge/deposits {opId, amount, agentId|shadowAccount}` — resolves the
  agent via the identity registry and credits the shadow balance. Idempotent
  per `opId`; the durable no-double-mint guarantee is enforced in the indexer's
  event log.
- `POST /bridge/withdrawals {commandId, amount, agentId|shadowAccount}` — checks
  withdrawable (idle) balance, burns shadow funds, then returns an exit
  authorization. Rejects amounts above withdrawable balance (no forced
  liquidation). Idempotent per `commandId`.
- `GET /bridge/deposits/:opId`, `GET /bridge/withdrawals/:commandId`,
  `GET /bridge/health`.

### Not yet wired (needs a live chain)

The on-chain escrow contract, the deposit-event watcher that calls
`/bridge/deposits`, and a real key-holding signing service are stubbed behind
`IndexerApi` and `signExit`. They can be implemented without touching the
lifecycle logic once the hidden node and escrow contracts exist.

See `../../docs/DEPOSITS_WITHDRAWALS_SPEC.md` for the full service contract.
