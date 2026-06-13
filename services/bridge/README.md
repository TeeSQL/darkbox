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

## Implemented modules (`src/`)

The withdrawal/deposit logic is implemented as pure, chain-agnostic modules so
it is unit-testable without a live chain. Chain interaction is behind
interfaces (`ShadowMintSubmitter`, `ShadowBurnSubmitter`, `NonceChecker`,
`ShadowBurnVerifier`); a live implementation wraps viem clients, the tests use
an in-memory `FakeShadowChain`.

- `watcher.ts` — normalizes ETH receives, ERC-20 transfers, and explicit
  `deposit(...)` events into a canonical `DepositObservation` carrying the
  `depositOpId` idempotency key (spec 6.4).
- `intents.ts` — FIFO deposit-intent matching / expiry (spec 6.5).
- `depositCoordinator.ts` — confirm → resolve beneficiary → map → idempotent
  mint, recovering from a mid-flight crash via `findExistingMint`.
- `withdrawalValidator.ts` — EIP-712 `WithdrawCommand` validation → `withdrawalId`.
- `signingService.ts` — the `darkbox-signer` verifier: signs a
  `WithdrawalAuthorization` only after all mandatory checks (spec 7.4), with the
  identical-re-issue guard (spec 7.5).
- `withdrawalCoordinator.ts` — validate → forced shadow burn of available
  balance → signing-service authorization (spec 7.1).
- `reconciliation.ts` — the section 12.1 invariant checks (no auto-correct).
- `store.ts` — persistence interface + in-memory implementation.

Shared EIP-712 types/schemas and the state machines live in `@darkbox/shared`
(`packages/shared/src/{eip712,states,idempotency,schemas}.ts`).

## Test

```sh
pnpm --filter @darkbox/bridge test     # node --test via tsx, no live chain
pnpm --filter @darkbox/shared test     # EIP-712 + idempotency unit tests
```

## End-to-end smoke test (live chains)

`scripts/smoke.ts` runs the full vertical against deployed contracts using the
viem-backed adapters in `src/chain/`: deposit USDC → shadow mint → withdrawable
balance → signed `WithdrawCommand` → forced burn → signing-service
authorization → public `withdraw(...)`, asserting escrow/shadow accounting
reconciles.

- **Local rehearsal (no secrets):** `./scripts/smoke-local.sh` boots one anvil,
  deploys everything, and runs the flow.
- **Testnet:** copy `.env.smoke.example` → `.env.smoke`, set `PUBLIC_RPC_URL`
  and a funded `DEPLOYER_PRIVATE_KEY`, then `./scripts/smoke-testnet.sh`. The
  public bridge + a mintable test USDC deploy to the testnet; the shadow
  controller runs on a local anvil (no shadow testnet exists yet). Only the one
  deployer key needs testnet gas.

Deploy scripts: `packages/contracts/script/Deploy.s.sol` (`DeployPublic`,
`DeployShadow`).

