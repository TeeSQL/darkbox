# Build context is the repo root (see docker-compose.yml) for the pnpm workspace.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/bridge/package.json services/bridge/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY services/bridge services/bridge
RUN pnpm --filter @darkbox/shared build && pnpm --filter @darkbox/bridge build

RUN adduser -D -u 10001 darkbox
USER darkbox
EXPOSE 8090
CMD ["pnpm", "--filter", "@darkbox/bridge", "start"]
