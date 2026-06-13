FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/transcriber/package.json ./services/transcriber/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
RUN pnpm --filter @darkbox/shared build

COPY services/transcriber ./services/transcriber
RUN pnpm --filter @darkbox/transcriber build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/transcriber/package.json ./services/transcriber/

RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/services/transcriber/dist ./services/transcriber/dist

RUN adduser -D -u 10001 darkbox
USER darkbox

ENV PORT=8095
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8095/health || exit 1

CMD ["node", "services/transcriber/dist/services/transcriber/src/index.js"]
