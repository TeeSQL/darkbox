# @darkbox/deployments

Typed access to the **Arc-testnet DarkBox prediction-market CLOB** deployment.

The source of truth is the canonical deploy artifact this repo already emits
from its forge scripts:

```
packages/contracts/deployments/darkbox-arc-grant-market-v2-5042002.json
```

(The frontier UI's `ui/public/deployment.json` is *generated from* this file via
`scripts/generate-frontier-ui-config.mjs` — so we read the artifact, not the
generated UI copy.) This package validates it and exposes typed addresses plus
an env mapping.

## Usage

```ts
import { arcTestnet, toEnv } from "@darkbox/deployments";

arcTestnet.darkbox.marketFactory;        // 0x23bc…9796
arcTestnet.canonicalMarket.yesBook;      // YES book
toEnv();                                 // { PUBLIC_CHAIN_ID, PUBLIC_RPC_URL, USDC_ADDRESS, MARKET_FACTORY_ADDRESS }
```

`toEnv()` emits only the env vars the deployment owns (the ones services read in
their `config.ts`). Private keys, API tokens and hidden-chain config stay in
sealed env and are not produced here. The Arc RPC URL is not in the artifact, so
it comes from the exported `ARC_TESTNET_RPC_URL` default.

### Generate the env file

```sh
pnpm --filter @darkbox/deployments gen-env
```

Writes `.env.arc-testnet` at the repo root (gitignored). Load it alongside the
sealed-secrets env when running services / docker-compose.

## After a redeploy

Re-run the relevant `packages/contracts/script/*Arc*` deploy script (it rewrites
the deployment artifact), then refresh the env:

```sh
pnpm --filter @darkbox/deployments gen-env
git add packages/contracts/deployments/darkbox-arc-grant-market-v2-5042002.json
git commit -m "deploy: refresh Arc PM-clob addresses"
```

To point at a different artifact (e.g. a new market version), update
`DEPLOYMENT_URL` in `src/index.ts`.
