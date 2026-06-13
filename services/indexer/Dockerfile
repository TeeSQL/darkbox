FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app

# Copy workspace manifests for layer-caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/indexer/package.json ./services/indexer/

RUN pnpm install --frozen-lockfile

# Build shared first
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
RUN pnpm --filter @darkbox/shared build

# Build indexer
COPY services/indexer ./services/indexer
RUN pnpm --filter @darkbox/indexer build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/indexer/package.json ./services/indexer/

RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/services/indexer/dist ./services/indexer/dist
# Migrations must land where the compiled migrate.js looks for them
# (dist/services/indexer/src/migrate.js → ../migrations). Copying to the non-dist
# path left readdir() throwing ENOENT → crash-loop. Keep the legacy path too so
# the resolver's fallback candidate also resolves.
COPY services/indexer/migrations ./services/indexer/dist/services/indexer/migrations
COPY services/indexer/migrations ./services/indexer/migrations

RUN adduser -D -u 10001 darkbox
USER darkbox

ENV PORT=8080
EXPOSE 8080

CMD ["node", "services/indexer/dist/services/indexer/src/index.js"]
