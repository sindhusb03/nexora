# Financial Kernel API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t nexora-api .
# Multi-stage: turbo prune, then a non-root runtime. The workspace packages export TypeScript,
# so the image runs the API through tsx.
FROM node:22-bookworm-slim AS prune

ENV CI=true
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo prune @nexora/api --docker

FROM node:22-bookworm-slim AS installer

ENV CI=true
RUN corepack enable
WORKDIR /app
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=installer --chown=node:node /app /app
WORKDIR /app
RUN corepack enable && npm pkg delete scripts.prepare && CI=true pnpm prune --prod
WORKDIR /app/apps/api
USER node
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Default: serve only. Set NEXORA_MIGRATE_ON_START=true to apply migrations first in the same container
# (that container then needs DATABASE_MIGRATION_URL). docker-compose.yml runs migrations as a separate job instead.
CMD ["sh", "-c", "if [ \"${NEXORA_MIGRATE_ON_START:-false}\" = true ]; then node_modules/.bin/tsx src/migrate.ts; fi && exec node_modules/.bin/tsx src/index.ts"]
