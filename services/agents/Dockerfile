# DarkBox agent runtime image.
#
# Currently runs the ETHGlobal showcase refresh loop (every 15 min) inside the
# AttestMesh core member, caching project snapshots to a mounted volume. Built
# from the repo root (COPYs the pnpm workspace + @darkbox/shared) — see
# .github/workflows/build-darkbox-images.yml.
#
# Single stage on purpose: the loop runs the TypeScript CLI via tsx, so the full
# (dev) dependency set must be present at runtime. @darkbox/shared is resolved
# from source by tsx via tsconfig.base.json path mappings.
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

# Workspace manifests first for layer-caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/agents/package.json ./services/agents/

RUN pnpm install --frozen-lockfile

# Source.
COPY packages/shared ./packages/shared
COPY services/agents ./services/agents
RUN pnpm --filter @darkbox/shared build

RUN adduser -D -u 10001 darkbox \
  && mkdir -p /data/ethglobal \
  && chown -R darkbox /data
USER darkbox

ENV SHOWCASE_EVENT_SLUG=newyork2025 \
    SHOWCASE_INTERVAL_SECONDS=900 \
    SHOWCASE_OUT=/data/ethglobal \
    RESOLVER_ENABLED=true \
    RESOLVER_DATA=/data \
    RESOLVER_MIN_CONFIDENCE=0.7

CMD ["sh", "services/agents/showcase-loop.sh"]
