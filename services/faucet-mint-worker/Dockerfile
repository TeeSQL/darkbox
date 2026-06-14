# Private-mesh CVM worker: drains the durable FaucetCoordinator ledger and mints
# the $5 promo / daemon-funding shadow-USDC grants on-chain via
# ShadowBridgeController.mintShadow, signed by the sealed coordinator key.
# Mirrors services/bridge + services/signer. Depends on @darkbox/bridge (the
# FaucetCoordinator) and @darkbox/shared, so both are built in the base stage.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/bridge/package.json ./services/bridge/
COPY services/faucet-mint-worker/package.json ./services/faucet-mint-worker/

RUN pnpm install --frozen-lockfile --filter @darkbox/faucet-mint-worker...

COPY packages/shared ./packages/shared
COPY services/bridge ./services/bridge
COPY services/faucet-mint-worker ./services/faucet-mint-worker
RUN pnpm --filter @darkbox/shared build
RUN pnpm --filter @darkbox/bridge build
RUN pnpm --filter @darkbox/faucet-mint-worker build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/bridge/package.json ./services/bridge/
COPY services/faucet-mint-worker/package.json ./services/faucet-mint-worker/

RUN pnpm install --frozen-lockfile --prod --filter @darkbox/faucet-mint-worker...

COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/services/bridge/dist ./services/bridge/dist
COPY --from=base /app/services/faucet-mint-worker/dist ./services/faucet-mint-worker/dist

# Non-root: the coordinator key is supplied via sealed env, never baked in.
RUN adduser -D -u 10001 darkbox
USER darkbox

ENV PORT=8090
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/health || exit 1

CMD ["node", "services/faucet-mint-worker/dist/services/faucet-mint-worker/src/index.js"]
