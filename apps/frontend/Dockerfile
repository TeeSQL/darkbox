# Build context is the repo root (see docker-compose.yml) so the pnpm workspace
# is available. The frontend serves static assets and proxies /public to the indexer.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile

COPY apps/frontend apps/frontend
RUN pnpm --filter @darkbox/frontend build

RUN adduser -D -u 10001 darkbox
USER darkbox
EXPOSE 3000
CMD ["pnpm", "--filter", "@darkbox/frontend", "start"]
