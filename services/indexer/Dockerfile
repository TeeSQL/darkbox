FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/indexer/package.json services/indexer/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/shared packages/shared
COPY services/indexer services/indexer
RUN pnpm --filter @darkbox/shared build && pnpm --filter @darkbox/indexer build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN adduser -D -u 10001 darkbox && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/indexer/package.json services/indexer/package.json
RUN pnpm install --prod --frozen-lockfile --filter @darkbox/indexer...
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/indexer/dist services/indexer/dist
USER darkbox
EXPOSE 8080
CMD ["pnpm", "--filter", "@darkbox/indexer", "start"]
