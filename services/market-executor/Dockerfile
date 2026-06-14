# Private-mesh worker: polls the indexer for APPROVED market proposals and
# creates the on-chain markets via DarkBoxMarketFactory.createMarket, signed by
# the sealed coordinator key. Mirrors services/market-approval-bot/Dockerfile.
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/market-executor/package.json services/market-executor/package.json
RUN pnpm install --frozen-lockfile --filter @darkbox/market-executor...
COPY packages/shared packages/shared
COPY services/market-executor services/market-executor
RUN pnpm --filter @darkbox/shared build
RUN pnpm --filter @darkbox/market-executor build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/market-executor/package.json services/market-executor/package.json
RUN pnpm install --frozen-lockfile --prod --filter @darkbox/market-executor...
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/services/market-executor/dist ./services/market-executor/dist

# Non-root: the coordinator key is supplied via sealed env, never baked in.
RUN adduser -D -u 10001 darkbox
USER darkbox

CMD ["node", "services/market-executor/dist/src/index.js"]
