FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/telegram-miniapp/package.json apps/telegram-miniapp/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/telegram-miniapp apps/telegram-miniapp
RUN pnpm --filter @darkbox/telegram-miniapp build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN adduser -D -u 10001 darkbox && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/telegram-miniapp/package.json apps/telegram-miniapp/package.json
RUN pnpm install --prod --frozen-lockfile --filter @darkbox/telegram-miniapp...
COPY --from=build /app/apps/telegram-miniapp/dist apps/telegram-miniapp/dist
COPY --from=build /app/apps/telegram-miniapp/src apps/telegram-miniapp/src
USER darkbox
WORKDIR /app/apps/telegram-miniapp
EXPOSE 3014
CMD ["pnpm", "start"]
