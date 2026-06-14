FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/ens/package.json ./services/ens/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY services/ens ./services/ens
RUN pnpm --filter @darkbox/ens build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/ens/package.json ./services/ens/

RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/services/ens/dist ./services/ens/dist

RUN adduser -D -u 10001 darkbox
USER darkbox

ENV PORT=8099
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8099/health || exit 1

CMD ["node", "services/ens/dist/services/ens/src/index.js"]
