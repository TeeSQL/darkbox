# Build context is the repo root (see docker-compose.yml) for the pnpm workspace.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY services/ens/package.json services/ens/
RUN pnpm install --frozen-lockfile

COPY services/ens services/ens
RUN pnpm --filter @darkbox/ens build

RUN adduser -D -u 10001 darkbox
USER darkbox
EXPOSE 8099
CMD ["pnpm", "--filter", "@darkbox/ens", "start"]
