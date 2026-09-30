# Web workspace. Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t nexora-web .
# NEXT_PUBLIC_* values are compiled into the client bundle, so they are build arguments.
FROM node:22-bookworm-slim AS prune

ENV CI=true
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo prune @nexora/web --docker

FROM node:22-bookworm-slim AS build

ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .

ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_NEXORA_DEV_HEADERS=false \
    NODE_ENV=production
RUN pnpm --filter @nexora/web build

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
