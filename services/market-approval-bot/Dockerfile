FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/market-approval-bot/package.json services/market-approval-bot/package.json
RUN pnpm install --frozen-lockfile --filter @darkbox/market-approval-bot...
COPY packages/shared packages/shared
COPY services/market-approval-bot services/market-approval-bot
RUN pnpm --filter @darkbox/market-approval-bot build
CMD ["pnpm", "--filter", "@darkbox/market-approval-bot", "start"]
