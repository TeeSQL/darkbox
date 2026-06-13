FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/agents/package.json ./services/agents/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
RUN pnpm --filter @darkbox/shared build

COPY services/agents ./services/agents
RUN pnpm --filter @darkbox/agents build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY services/agents/package.json ./services/agents/

RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/services/agents/dist ./services/agents/dist
COPY services/agents/config ./services/agents/config

RUN mkdir -p /app/logs/agents \
  && adduser -D -u 10001 darkbox \
  && chown -R darkbox:darkbox /app/logs
USER darkbox

ENV AGENT_STRATEGY=random \
    AGENT_KIND=random-mixed \
    AGENT_COUNT=3 \
    AGENT_TURNS=0 \
    AGENT_RUN_ID=cvm-v0 \
    DARKBOX_INDEXER_URL=http://darkbox-indexer:8080 \
    AGENT_TURN_LOG_DIR=/app/logs/agents \
    AGENT_IDENTITIES_FILE=services/agents/config/agent-identities.json \
    MIN_WORKERS=2 \
    MAX_WORKERS=8 \
    TARGET_TURNS_PER_MINUTE=20 \
    MIN_AGENT_INTERVAL_MS=30000 \
    MAX_AGENT_INTERVAL_MS=900000 \
    SCHEDULER_TICK_MS=2000 \
    JITTER_PCT=30 \
    MAX_IN_FLIGHT_PER_AGENT=1

VOLUME ["/app/logs/agents"]

CMD ["sh", "-lc", "node services/agents/dist/services/agents/src/noise.js --strategy \"$AGENT_STRATEGY\" --kind \"$AGENT_KIND\" --agents \"$AGENT_COUNT\" --turns \"$AGENT_TURNS\" --indexer-url \"$DARKBOX_INDEXER_URL\" --log-dir \"$AGENT_TURN_LOG_DIR\" --run-id \"$AGENT_RUN_ID\" --agent-identities \"$AGENT_IDENTITIES_FILE\""]
