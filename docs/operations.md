# Operations

How to run the Financial Kernel API and web app outside a laptop. The kernel rules in `CLAUDE.md` still apply. Nothing here relaxes maker-checker, publication, RLS, or hash rules.

## 1. Processes

| Process       | Command                                                                         | Notes                                                                                         |
| ------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Migrations    | `pnpm --filter @nexora/api migrate`                                             | Runs as the schema owner. Idempotent. Takes an advisory lock, so concurrent runs wait         |
| API           | `pnpm --filter @nexora/api start`                                               | Hono on `PORT` (default 8787). Refuses to boot if migrations are pending, drifted, or unknown |
| Web           | `pnpm --filter @nexora/web build && pnpm --filter @nexora/web start`            | `next start` on port 3000                                                                     |
| Create a user | `NEXORA_NEW_USER_PASSWORD=... pnpm --filter @nexora/api user:create <actor-id>` | For production, where self sign-up is off. The password comes from the environment, not argv  |

The API reads only the process environment. It does not load `.env`. Local scripts and compose pass variables explicitly.

## 2. Environment

`.env.example` lists every variable with placeholders. The API fails closed in production:

| Variable                                                        | Production                                                                                                               | Development default                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `NODE_ENV`                                                      | `production`                                                                                                             | `development`                                 |
| `DATABASE_URL`                                                  | Required. The API login role (see section 3)                                                                             | Unset means in-memory PGlite, lost on restart |
| `DATABASE_MIGRATION_URL`                                        | Schema owner, used only by `migrate`                                                                                     | Falls back to `DATABASE_URL`                  |
| `NEXORA_API_LOGIN_ROLE`                                         | Optional. `migrate` grants `nexora_app` to this role                                                                     | Unset                                         |
| `AUTH_SECRET`                                                   | Required, 32+ characters (`openssl rand -base64 48`)                                                                     | Ephemeral; sessions end on restart            |
| `AUTH_SESSION_TTL_SECONDS`                                      | 300–604800                                                                                                               | 28800                                         |
| `AUTH_ALLOW_SIGNUP`                                             | Default `false`                                                                                                          | `true`                                        |
| `AUTH_COOKIE_SECURE`                                            | Must be `true` (default)                                                                                                 | `false`                                       |
| `AUTH_COOKIE_SAMESITE`                                          | `Lax` (default), `Strict`, or `None` with a secure cookie                                                                | `Lax`                                         |
| `NEXORA_REGION`                                                 | Optional. Pins every session to one region                                                                               | Unset                                         |
| `PLATFORM_ADMIN_ACTOR_IDS`                                      | Comma-separated actors allowed to provision tenants. Default empty                                                       | `platform-admin`                              |
| `NEXORA_DEV_HEADERS`                                            | Refused when `true`                                                                                                      | `false`                                       |
| `WEB_ORIGIN`                                                    | Comma-separated browser origins (scheme and host)                                                                        | `http://localhost:3000`                       |
| `API_BODY_LIMIT_BYTES`                                          | 1 KiB – 50 MiB                                                                                                           | 8388608                                       |
| `TRUST_PROXY`                                                   | `true` only behind a proxy that appends `X-Forwarded-For`                                                                | `false`                                       |
| `TRUST_PROXY_HOPS`                                              | Rightmost hops our proxies append. `1` behind the ALB. Fewer `X-Forwarded-For` entries than this uses the socket address | `1`                                           |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX` | Tune per deployment                                                                                                      | 60000, 600, 20                                |
| `DEMO_MODE`                                                     | Refused when `true`. Default `false`                                                                                     | `false` unless set to `true`                  |
| `OIDC_PROVIDERS`                                                | Optional JSON array. No provider is required (section 5)                                                                 | Unset                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                   | Optional (section 6)                                                                                                     | Unset                                         |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`                 | `otlp` or `none`. `otlp` requires the endpoint                                                                           | Follow the endpoint when unset                |
| `SENTRY_DSN`                                                    | Optional `https://key@host/project`. Unset is a no-op                                                                    | Unset                                         |
| `API_URL`                                                       | Server-side API URL for the web app                                                                                      | `http://localhost:8787`                       |
| `NEXT_PUBLIC_API_URL`                                           | Browser API URL. Compiled into the web bundle at build time                                                              | `http://localhost:8787`                       |
| `NEXT_PUBLIC_NEXORA_DEV_HEADERS`                                | `false`. Compiled in at build time                                                                                       | `false`                                       |

Blank values are treated as unset.

Production refuses to start when `DATABASE_URL` or `AUTH_SECRET` is missing, `NEXORA_DEV_HEADERS=true`, `DEMO_MODE=true`, the cookie is not secure, or the database login is privileged.

## 3. Database roles

RLS is only as strong as the login the API uses. Superusers, `BYPASSRLS` roles, and table owners bypass it.

- **Schema owner** (for example `nexora_owner`). Owns the tables and runs migrations. Never used by the API process.
- **`nexora_app`**. Created by migration `0001`. `NOLOGIN`, bound by forced RLS, and has no delete on journals, lines, audit, runs, or domain events. Each request runs `SET LOCAL ROLE nexora_app` with `app.tenant_id` set from the session.
- **API login** (for example `nexora_api`). Must be a member of `nexora_app` and must not be a superuser, hold `BYPASSRLS`, or own kernel tables.

```sql
CREATE ROLE nexora_api LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '...';
GRANT nexora_app TO nexora_api;
```

Instead of the `GRANT`, you can set `NEXORA_API_LOGIN_ROLE=nexora_api` when running `migrate`, which grants membership after the schema exists. `migrate` refuses to grant to a superuser or `BYPASSRLS` role.

At boot the API checks:

- `nexora_app` exists and is safe.
- The login can assume `nexora_app`.
- Every migration is applied with a matching checksum.
- The login is not privileged.

In production a privileged login is fatal. In development it is logged as a warning.

### Existing databases

A database migrated by hand before the `schema_migrations` ledger existed needs a one-time baseline:

```
DATABASE_MIGRATION_URL=... pnpm --filter @nexora/api migrate --baseline
```

The baseline records the checksums of migrations whose objects already exist. It does not re-run them.

## 4. Docker and compose

- `apps/api/Dockerfile` is a multi-stage `turbo prune` build. It runs as `node` with a healthcheck on `/readyz` (`/ready` stays as an alias). Setting `NEXORA_MIGRATE_ON_START=true` runs migrations before the server. Prefer a separate migration job so the runtime login never needs DDL.
- `apps/web/Dockerfile` is the same prune shape, takes `NEXT_PUBLIC_API_URL` as a build argument, and forces `NEXT_PUBLIC_NEXORA_DEV_HEADERS=false`.
- `docker-compose.yml` starts Postgres 17 with pgvector (`deploy/postgres/20-pgvector.sql` creates the extension only in that local image), MinIO as a local upload stand-in, creates `nexora_api` (`deploy/postgres/10-api-login-role.sh`), runs `migrate` as the owner, then starts the API as `nexora_api` and the web app. `DEMO_MODE` is `false`. Do not point the compose file at a cloud account.

```
AUTH_SECRET=... POSTGRES_PASSWORD=... NEXORA_API_DB_PASSWORD=... MINIO_ROOT_PASSWORD=... docker compose up --build
```

AWS `ap-south-1` templates and residency notes are in [hosting.md](hosting.md). Those templates are not applied.

Compose serves plain HTTP on localhost with production settings, including a secure cookie. Browsers accept secure cookies on `http://localhost`, and ports 3000 and 8787 are same-site. In any real deployment, put TLS in front of both services.

Create the first operator inside the stack:

```
docker compose run --rm -e NEXORA_NEW_USER_PASSWORD=... api node_modules/.bin/tsx src/create-user.ts platform-admin
```

Then set `PLATFORM_ADMIN_ACTOR_IDS=platform-admin` and restart the API.

CI (`.github/workflows/ci.yml`) runs typecheck and tests with PGlite, then a Postgres 17 service job, then both image builds. The Postgres job:

- Migrates twice.
- Boots the API in production mode as `nexora_api` and checks `/ready`.
- Checks that forged identity headers get 401.
- Checks that boot is refused as a superuser and without `DATABASE_URL`.

None of this needs Neon credentials.

## 5. Identity

- Sessions are an HMAC-signed session id in an HttpOnly `SameSite` cookie. The cookie is `__Host-nexora_session` when secure and `nexora_session` otherwise. Each session is an `auth_session` row with a family id. Logout revokes that row. `POST /auth/session/rotate` and tenant selection issue a new row and revoke the old one. Presenting a revoked cookie revokes the whole family. Expiry does not.
- Actor, tenant, and region come from the session. `POST /auth/session/tenant` selects a tenant only when the actor has a membership, and only in the tenant's home region. The request sets `app.tenant_id` and `app.actor_id` for RLS.
- Writes need `x-csrf-token` (an HMAC of the session id returned by `/auth/session`) and an allowed `Origin`.
- Passwords are argon2id (memory 19456 KiB, time 2, parallelism 1). Existing scrypt hashes still verify. New passwords are argon2id.
- Email magic links and optional TOTP (QR enroll, recovery codes) are available. The email sender is an interface; the shipped transport logs a redacted recipient and keeps the token in a dev mailbox. `GET /auth/dev/mailbox` exists only outside production.
- Login and magic-link requests share a credential rate limit. Five failures in 15 minutes lock that subject for 15 minutes. Errors stay generic (`AUTH_INVALID_CREDENTIALS`, then `AUTH_LOCKED`) so an identifier is not confirmed.
- `DEMO_MODE` is off unless set to `true`, and `true` is refused when `NODE_ENV=production`. When it is on, the seeded company and `sindhu` / `nexora-demo-2026` are available. The dev mailbox is registered only when `DEMO_MODE=true` and the process is not production.
- OIDC is optional. `OIDC_PROVIDERS` is a JSON array of `{id, label, issuer, clientId, clientSecret, redirectUri, scopes}`. Start and callback routes exist. The callback does not exchange a code or open a session.
- Auth events (login success and failure, magic link sent and used, 2FA enroll and verify, session revoke, role change) append to `auth_audit_event` under forced RLS.
- The header seam (`x-actor-id`, `x-tenant-id`, `x-region`) exists only when `NEXORA_DEV_HEADERS=true`, and production refuses that flag. Local dev-header use needs both `NEXORA_DEV_HEADERS=true` on the API and `NEXT_PUBLIC_NEXORA_DEV_HEADERS=true` on the web app.

### Bootstrap in production

1. Set `PLATFORM_ADMIN_ACTOR_IDS=<operator>`.
2. Run `user:create <operator>`.
3. Sign in and provision a tenant naming a registered owner.
4. The owner grants roles through `POST /v1/memberships`.

### Not built

- A live email provider, a completed OIDC token exchange, and password reset.
- A platform role table. `PLATFORM_ADMIN_ACTOR_IDS` is still an allow-list.

## 6. Observability

- Logs are pino JSON, one object per line, with `requestId`, `actorId`, `userId`, `tenantId`, `orgId`, method, route, status, and duration.
- Redaction covers passwords, tokens, cookies, CSRF values, email addresses, and secrets. Errors log their name and SQLSTATE code only. Financial payloads are not logged.
- Every response carries `x-request-id`. A well-formed incoming id is reused.
- `GET /health` and `GET /healthz` are liveness. `GET /ready` and `GET /readyz` ping the store and compare applied migrations with the known set. A failure returns 503 without a connection string.
- With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the API exports traces and metrics over OTLP HTTP unless `OTEL_TRACES_EXPORTER` or `OTEL_METRICS_EXPORTER` is `none`. Unset endpoint means the OpenTelemetry API stays a no-op.
- `SENTRY_DSN` posts a Sentry-compatible envelope whose exception value is `Unexpected failure`. Unset DSN is a no-op.

## 7. Known limits

- Rate limits are fixed-window and per process. Multiple replicas each keep their own counters. Use an edge or shared-store limiter for real abuse protection.
- The web CSP sets `frame-ancestors`, `base-uri`, `form-action`, and `object-src`. It does not yet restrict `script-src` with nonces.
- Only the PGlite path and the CI Postgres job have exercised the runtime. No managed Postgres (Neon or otherwise) has been verified from this repository.
