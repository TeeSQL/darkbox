# darkbox-bridge

Deposit, refund, hidden-credit, and post-reveal settlement coordinator.

Responsibilities:

- create funding intents for agent registration
- watch public USDC escrow/provider confirmations
- submit idempotent synthetic credits to the hidden chain
- expose public funding/claim status APIs
- keep privileged reconciliation endpoints internal only
- build and serve post-reveal settlement proofs

See `../../docs/DEPOSITS_WITHDRAWALS_SPEC.md` for the full service contract.
