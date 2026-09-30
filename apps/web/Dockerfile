# Web workspace. Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t nexora-web .
# NEXT_PUBLIC_* values are compiled into the client bundle, so they are build arguments.
FROM node:22-bookworm-slim AS build

ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/kernel/package.json packages/kernel/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter "@nexora/web..."

COPY apps/web apps/web

ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_NEXORA_DEV_HEADERS=false \
    NODE_ENV=production
RUN pnpm --filter @nexora/web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
