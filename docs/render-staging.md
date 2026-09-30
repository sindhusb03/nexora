# Render staging

Demo staging for https://staging.nexafi.io. The `*.onrender.com` URL works as well. This is not production.

Render cannot see the Origin repository for this account. The Blueprint deploys the private GitHub repository https://github.com/sindhusb03/nexora, branch `main`. `render.yaml` sets `branch: main`. To track another GitHub branch, change `branch` and sync the Blueprint. Do not point this service at Origin.

## What deploys

One Docker web service, `nexora-staging`, region `singapore`, plan `free`.

- Next.js listens on `0.0.0.0:$PORT` (`PORT=4317`).
- The API listens on `127.0.0.1:8787`. Render does not publish that port.
- The browser talks only to the web origin. `NEXT_PUBLIC_API_URL=/api` is baked into the image. Next rewrites `/api/:path*` to `http://127.0.0.1:8787/:path*` when `API_PROXY_TARGET` is set at build time. `app/api/kernel-health` stays a Next route.
- `DATABASE_URL` is unset. The API uses in-memory PGlite and seeds the demo company on startup. `/app/data` is writable by the `node` user; the free plan has no disk, and this process does not write the ledger there.
- The container default is `NODE_ENV=production` (Next.js). `deploy/render/start.sh` starts the API with `NODE_ENV=staging`. The production guard still keys on `NODE_ENV=production` and still refuses `DEMO_MODE`. `APP_ENV=staging` is a label; the API does not read it.

## Blueprint

1. In Render, create a Blueprint from https://github.com/sindhusb03/nexora (`render.yaml` on `main`).
2. Leave every variable as written. `AUTH_SECRET` uses `generateValue: true` (base64 256-bit). No other secret is required.
3. `start.sh` appends `RENDER_EXTERNAL_URL` to `WEB_ORIGIN` when Render sets it, so both `https://staging.nexafi.io` and `https://<service>.onrender.com` are allowed. The session cookie has no `Domain` attribute (`SameSite=Lax`, `Secure` via `AUTH_COOKIE_SECURE=true`).
4. `TRUST_PROXY=true` and `TRUST_PROXY_HOPS=1`. Render appends one `X-Forwarded-For` hop. Next.js 15's rewrite proxy forwards that header and does not set `xfwd`, so it does not append another hop. The API then uses the address Render appended. A missing or shorter header falls back to the socket address (`127.0.0.1` from Next), which would share one rate-limit bucket.
5. Health check: `/api/readyz` (public port, proxied to the API). It returns 200 only after the store is ready.

## Custom domain

Add a DNS CNAME for `staging.nexafi.io` to the service hostname Render shows (`<service>.onrender.com`). Render provisions TLS after the record resolves. `domains: [staging.nexafi.io]` is already in `render.yaml`.

## Demo login

User `sindhu`, password `nexora-demo-2026`. The API auth config returns region `us-east-1` while demo mode is on. Sign-up is off.

## Limits

- Free plan: the service sleeps after idle. The next request waits for a cold start. PGlite is in memory, so each start re-seeds the demo company and drops anything written in the previous process.
- Plan `starter` (`0.5c-512mb`) avoids sleep. It still has no durable ledger unless `DATABASE_URL` is set, and demo mode must stay off if the API process is `NODE_ENV=production`.
- Not a production books deployment. Do not put customer data on this service.
