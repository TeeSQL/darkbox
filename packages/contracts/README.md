# @darkbox/contracts

Solidity contracts for DarkBox deposits + withdrawals (spec:
`docs/DEPOSITS_WITHDRAWALS_SPEC.md`). Built and tested with [Foundry].

## Contracts

- `src/DarkBoxBridge.sol` — public escrow. Custodies real USDC/ETH, records
  deposits (`receive()`, `deposit(...)`), and releases funds only against a
  signing-service EIP-712 `WithdrawalAuthorization` with an unused per-owner
  nonce. Admin-only `emergencyWithdraw`, `setSigner`, and split deposit/
  withdrawal pause flags. Self-contained EIP-712 + ECDSA (no external deps).
- `src/ShadowBridgeController.sol` — shadow-side registry + ledger. Canonical
  owner↔shadow-account mapping, idempotent `mintShadow(depositOpId, ...)`,
  `burnForWithdrawal(...)` that consumes only withdrawable available balance
  (`balance - locked`), and a `withdrawableBalance` view.
- `src/mocks/MockERC20.sol` — minimal ERC20 standing in for public USDC in tests.

## Setup & test

Requires Foundry (`forge`). Install: <https://book.getfoundry.sh/getting-started/installation>.

```sh
pnpm --filter @darkbox/contracts run setup   # vendors forge-std into lib/ (one-time)
pnpm --filter @darkbox/contracts run test     # forge test
```

`test/EIP712Parity.t.sol` asserts the Solidity `WithdrawCommand` /
`WithdrawalAuthorization` digests are byte-identical to the viem digests used by
the bridge service (`packages/shared`), so the user and signing-service signing
paths interoperate.

[Foundry]: https://book.getfoundry.sh
