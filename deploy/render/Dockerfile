# Demo staging image. One container: Next.js on $PORT and the API on 127.0.0.1:8787.
# Build from the repository root:
#   docker build -f deploy/render/Dockerfile -t nexora-render .
FROM node:22-bookworm-slim AS build

ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# NEXT_PUBLIC_API_URL is inlined into the client. /api stays valid on
# *.onrender.com and staging.nexafi.io. API_PROXY_TARGET is read when Next builds rewrites.
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_NEXORA_DEV_HEADERS=false \
    API_PROXY_TARGET=http://127.0.0.1:8787 \
    NODE_ENV=production
RUN pnpm --filter @nexora/web build
# next start loads next.config.ts. Copy TypeScript out before prune removes devDependencies.
RUN mkdir -p /opt/runtime-keep && cp -aL node_modules/typescript /opt/runtime-keep/typescript
# prune re-runs the root prepare script. Husky is a devDependency and is gone by then.
RUN pnpm prune --prod --ignore-scripts \
    && cp -a /opt/runtime-keep/typescript node_modules/typescript

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4317 \
    API_PROXY_TARGET=http://127.0.0.1:8787 \
    API_URL=http://127.0.0.1:8787
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 755 /app/deploy/render/start.sh
USER node
EXPOSE 4317
CMD ["/app/deploy/render/start.sh"]
