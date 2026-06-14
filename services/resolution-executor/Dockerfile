# Private-mesh CVM worker: polls the decision source (Ocean's market-closing
# lane / PR #22) for approved resolutions and EXECUTES them on-chain via
# DarkBoxMarketFactory.resolveMarket / voidMarket, signed by the sealed
# coordinator key. Mirrors services/market-executor/Dockerfile.
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/resolution-executor/package.json services/resolution-executor/package.json
RUN pnpm install --frozen-lockfile --filter @darkbox/resolution-executor...
COPY services/resolution-executor services/resolution-executor
RUN pnpm --filter @darkbox/resolution-executor build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/resolution-executor/package.json services/resolution-executor/package.json
RUN pnpm install --frozen-lockfile --prod --filter @darkbox/resolution-executor...
COPY --from=base /app/services/resolution-executor/dist ./services/resolution-executor/dist

# Non-root: the coordinator key is supplied via sealed env, never baked in.
RUN adduser -D -u 10001 darkbox
USER darkbox

CMD ["node", "services/resolution-executor/dist/src/index.js"]
