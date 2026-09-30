# Financial Kernel API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t nexora-api .
# The workspace packages export TypeScript source, so the image runs the API through tsx.
FROM node:22-bookworm-slim

ENV CI=true
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/kernel/package.json packages/kernel/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter "@nexora/api..."

COPY packages/kernel packages/kernel
COPY packages/db packages/db
COPY apps/api apps/api

ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app/apps/api
USER node
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Default: serve only. Set NEXORA_MIGRATE_ON_START=true to apply migrations first in the same container
# (that container then needs DATABASE_MIGRATION_URL). docker-compose.yml runs migrations as a separate job instead.
CMD ["sh", "-c", "if [ \"${NEXORA_MIGRATE_ON_START:-false}\" = true ]; then node_modules/.bin/tsx src/migrate.ts; fi && exec node_modules/.bin/tsx src/index.ts"]
