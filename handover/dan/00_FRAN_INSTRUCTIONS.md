# DarkBox Dan Handover — Fran Instructions Capture

Date: 2026-06-13 UTC
Source: DarkBox Telegram general topic
Priority: make Dan's morning easy. He will not have time to reverse-engineer the system.

## Top priority

We must be ready for Dan tomorrow with a complete, human-readable but detailed onboarding package. Dan should be able to hand the package to his agent and have the agent understand exactly what exists, what is missing, and how to deploy/run/debug it.

## Required outputs

1. Every service that needs to be deployed should exist.
2. Clearly define internal vs external-facing services/endpoints.
3. Clearly define external dependencies/endpoints: RPCs, Phala/CVM, Venice/current model provider usage, Base/Arc, any other provider.
4. Write a very detailed runbook covering every piece of the puzzle. It should be suitable for Dan to send to his agent.
5. Create a frontend package for Kristel/Nicolai including all API endpoints and data, ideally as a nice Swagger/OpenAPI spec.
6. Ensure deploy scripts exist for all onchain/private-network contracts.
7. Prepare a deployer private key, store it in `.env` on teebox and in Ocean's secrets, with gas for Base/Arc bridges when ready. Also do a Base Sepolia testnet deployment for Dan.
8. Run the audit routine on all smart contracts, put PDFs in the repo, fix findings, then rerun. Also audit the Frontier/orderbook integration.

## Docker/CVM requirements

- Everything destined for CVM must be dockerized.
- Make a plan, open tmux with `/goal`, create all Dockerfiles, document in the runbook.
- Wire Docker networking so services can communicate correctly.
- Document the networking carefully because in-CVM debugging will be painful.
- If possible, do a local dockerized test run outside CVM, then kill it.

## Missing things Dan needs to know/do

- Private keys and their relation to users outside the private network are currently insecurely generated/stored. Dan needs to fix this.
- Proposed product direction: use only the Telegram Mini App because Telegram gives built-in auth. Users are authenticated by Telegram id/handle. For withdrawals, users specify the destination address inside the authenticated Mini App.
- If we also ship a desktop/web app, we need a second auth path, probably a wallet signature, and must support both Telegram auth and wallet signature auth.
- Bridge exists, but the withdrawal signer service is insecure and needs to move into TEE security land.
- User whisper ingress is not fully proven. Required flow: authenticated user channel receives mic audio, transcribes, sends to agent, and replaces or appends prior instructions.
- Runbook must explain how to run the fake in-house agents.

## Marketing / demo plan Dan should know

- Every user gets a $5 signup bonus.
- Hedge the signup bonus liability by putting $200 on NO for “will we win the hackathon”. This is worth it if users make the demo look alive before judges.
- Sponsor-judge line: “I'll create a market for your project. If less than 10 projects use your SDK, at least you'll earn some money. Hedging!”
- Need a replay video after a session finishes. The replay should show the opened box: trades, new players joining, new markets being created. It can be fake for the judges demo, but needs to exist as pitch collateral.

## Execution constraints

- Use multiple agents/workstreams.
- Put some work on this box and some on teebox.
- Do not overload either machine.
- Push everything to GitHub frequently.
- Keep `/home/xiko/darkbox` and `/home/ubuntu/darkbox` synced.
- At the end, post in Telegram tagging `@lsdan` with links to files and who each file is for: Dan vs Dan's agent vs Kristel/Nicolai.
