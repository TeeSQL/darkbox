FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app

# Copy workspace manifests for layer-caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/gateway/package.json ./services/gateway/

RUN pnpm install --frozen-lockfile

# Build shared first
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
RUN pnpm --filter @darkbox/shared build

# Build gateway
COPY services/gateway ./services/gateway
RUN pnpm --filter @darkbox/gateway build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/gateway/package.json ./services/gateway/

RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/services/gateway/dist ./services/gateway/dist

RUN adduser -D -u 10001 darkbox
USER darkbox

ENV PORT=8090
EXPOSE 8090

# Liveness: the gateway exposes an unauthenticated /health probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/health || exit 1

CMD ["node", "services/gateway/dist/services/gateway/src/index.js"]
