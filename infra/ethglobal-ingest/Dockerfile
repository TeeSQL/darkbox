FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/indexer/package.json services/indexer/package.json
COPY services/agents/package.json services/agents/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS runtime
COPY scripts scripts
ENV ETHGLOBAL_EVENT_SLUG=newyork2026
CMD ["sh", "-lc", "pnpm fetch:ethglobal --event ${ETHGLOBAL_EVENT_SLUG}"]
