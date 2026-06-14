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
- `faucet.ts` — durable ledger/queue coordinator for withdrawable $5 human
  promo mints and $5 daemon funding mints. It records deterministic faucet
  operation ids, enforces one human promo per Telegram id and one daemon funding
  allocation per daemon id/address/shadow account, and submits through the same
  idempotent shadow mint seam used by public deposits.
- `reconciliation.ts` — the section 12.1 invariant checks (no auto-correct).
- `store.ts` — persistence interface + in-memory implementation.

Shared EIP-712 types/schemas and the state machines live in `@darkbox/shared`
(`packages/shared/src/{eip712,states,idempotency,schemas}.ts`).

## Test

```sh
pnpm --filter @darkbox/bridge test     # node --test via tsx, no live chain
pnpm --filter @darkbox/shared test     # EIP-712 + idempotency unit tests
```

## Faucet handoff

The faucet is a bridge/signer-boundary concern. The public gateway may enqueue a
human promo request, but it never holds mint authority or private keys.

Expected internal bridge API shape for DarkDan's CVM integration:

- `POST /internal/faucet/human-promo`
  - `telegramId`, `inviteId`, `owner`, `shadowAccount`, `amount`, `currency`,
    `requestedAt`
- `POST /internal/faucet/daemon-funding`
  - `daemonId`, `daemonAddress`, `shadowAccount`, `amount`, `currency`,
    `requestedAt`

Both paths should upsert through `FaucetCoordinator`, persist the record, and let
the bridge worker call `processNext()` from inside the trusted shadow mint
boundary. The coordinator uses the deterministic operation id as the
`mintShadow` idempotency key, so retries and crash recovery do not double mint.

Daemon funding CLI:

```sh
pnpm --filter @darkbox/bridge fund:daemons -- --game-id=$GAME_ID --dry-run
BRIDGE_URL=http://darkbox-bridge:8081 pnpm --filter @darkbox/bridge fund:daemons -- --game-id=$GAME_ID
```

Relevant env:

- `BRIDGE_URL` — internal bridge URL used by the gateway/CLI to enqueue faucet
  records; unset means gateway records a pending handoff locally for tests/dev.
- `GAME_ID` — included in deterministic human/daemon faucet operation ids.
- `FAUCET_AMOUNT` — CLI override for daemon funding amount, default `5.00`.

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
