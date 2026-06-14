# Build context is the repo root (see docker-compose.yml) so the pnpm
# workspace and @darkbox/shared are available.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

# Install workspace dependencies using the lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/indexer/package.json services/indexer/
RUN pnpm install --frozen-lockfile

# Build shared, then the indexer.
COPY packages/shared packages/shared
COPY services/indexer services/indexer
RUN pnpm --filter @darkbox/shared build && pnpm --filter @darkbox/indexer build

RUN adduser -D -u 10001 darkbox
USER darkbox
EXPOSE 8080
CMD ["pnpm", "--filter", "@darkbox/indexer", "start"]
