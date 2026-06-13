# darkbox-bridge

Deposit, shadow-mint, withdrawal, and emergency-exit coordinator.

Responsibilities:

- detect direct USDC transfers, explicit deposit calls, and provider/composed funding events
- resolve onchain owner wallets to shadow accounts
- submit idempotent shadow mints to the shadow EVM after confirmed public deposits
- expose public deposit status, account mapping, withdrawable balance, and withdrawal command APIs
- validate user-signed withdrawal commands
- force shadow-EVM burn/transfer of withdrawable available balance before public withdrawal
- request signing-service authorization after shadow burn confirmation
- keep privileged reconciliation endpoints internal only
- support multisig emergency withdrawals

See `../../docs/DEPOSITS_WITHDRAWALS_SPEC.md` for the full service contract.
