# Nexora

Nexora is the governed AI finance analyst that keeps growing companies board-ready and deal-ready. The product is a Next.js studio on a server-side Financial Kernel. Models propose and explain. The kernel calculates and records.

The studio is [http://127.0.0.1:4317](http://127.0.0.1:4317) (`/studio`). The earlier Gate G0 shell remains at `/classic`. The build contract is [docs/MASTER_IMPLEMENTATION.md](docs/MASTER_IMPLEMENTATION.md). Presentation rules are in [docs/UI-UX.md](docs/UI-UX.md). What the MVP ships, and what is still stubbed, is in [docs/MVP_REPORT.md](docs/MVP_REPORT.md).

## Constitution

These rules override local convenience.

1. The server-side Financial Kernel is the only source of financial truth.
2. Material calculations are deterministic and covered by golden tests. Models do not compute final numbers.
3. AI may propose and explain later. The kernel calculates and records.
4. Every material number carries lineage: engine version plus a hash of its inputs.
5. Posted journals are immutable. Corrections are new reversal journals.
6. The browser does not own financial truth. The API recomputes every total.
7. Scenarios, statements, and calculation runs are versioned outputs, not edits of the base.
8. Tenant isolation is absolute. Every business table is scoped by `tenant_id` and Postgres row-level security.
9. Authorization and financial safety fail closed.
10. Each tenant has a home region. A request for another region is rejected. Cross-region serving is a later explicit design.

## What the studio contains

- `@nexora/kernel` (`fe-kernel-0.2.0`) — money in integer minor units, journal balance, three-statement derivation (income statement is period movement; prior earnings roll into retained earnings), driver forecast, 13-week cash, variance, quality-of-earnings bridge, year-end Gordon DCF, FX, formula graphs, publication, intercompany elimination, and a number-grounding check for model text.
- `@nexora/db` — Postgres schema, append-only audit, posted-journal triggers, forced row-level security, and a Drizzle store. Migration `0004_workspace.sql` holds non-ledger workspace facts (drivers, proposals, documents, flags).
- `@nexora/api` — Hono API on port 8787. Signed session cookies. Roles come from membership rows. The workspace route recomputes statements, forecast, cash, variance, and the earnings bridge in the kernel. The copilot answers from kernel outputs and tenant documents, then rejects any number that is not in that corpus.
- `@nexora/web` — Next.js 15 studio. It does not import the kernel. Charts and grids display server minor-unit strings.

Without `DATABASE_URL`, the API uses embedded PGlite and seeds Nazareno Services LLC (USD, `us-east-1`) when `NEXORA_SEED_DEMO` is not `false`. Sign in as `sindhu`, `controller`, `viewer`, or `platform-admin` with password `nexora-demo-2026` (override with `NEXORA_DEMO_PASSWORD`).

## Done in this MVP, and what is next

Done: onboarding certificate, three-statement grid with journal drill-down and CSV export, driver forecast and downside scenario, 13-week cash, variance, QoE-lite bridge, board pack with lineage, CFO dashboard, command palette, grounded copilot (mock without a key, live when `AI_API_KEY` or `OPENAI_API_KEY` is set), approvals inbox, organization admin, and platform admin (tenant status, time-boxed support access, flags, connector health).

Next, and currently stubbed:

- Retrieval is in-process hybrid keyword plus a hashed-token vector. `pgvector` is not created in the shared migration because the stock Postgres 17 image has no extension.
- The reconciliation certificate compares kernel ending cash with itself. Bank PDF totals are not parsed.
- The statement grid is monthly statement totals, not an account-level trial balance.
- The earnings bridge starts from kernel net income. The demo books have no depreciation, so the label is normalized earnings.
- Demo books are a balanced reconstruction posted through the ledger. The source workbooks are not imported and are not in git.
- Excel add-in, Tally, and Zoho connectors are flags or health rows, not live syncs.
- Company directory and support-access expiry live in process memory, same as the ephemeral PGlite store.
- Support access is a time-boxed auditor membership, not an impersonation bypass of row-level security.
- Valuation, capital, and deals stay on the existing `/program` routes.

## Decisions you should not reverse casually

- Ledger amounts are integer minor units (`numeric(38,0)`). Analytical outputs such as DCF use `decimal.js` at precision 40 and are serialized at 12 decimal places. IEEE-754 numbers are rejected in material hashes.
- A journal is inserted as `draft`, lines are written, then one update moves it to `posted`. The database rejects a second update or a delete. A reversal is a new posted journal with `reverses_journal_id`.
- Closed periods stay closed. A reversal posts into a later open period.
- Retained earnings close on the statement is derived. The source journals are not rewritten.
- DCF uses year-end discounting. Terminal free cash flow is `FCF_n * (1 + g)`. The caller cannot submit enterprise value.
- FX translation returns a derived amount and keeps the source. Missing rates fail. Rounding is half-even.
- Formula cycles fail. This kernel version has no iterative solver.
- Account currency is copied from the legal entity. A journal in another currency is rejected until an explicit FX step exists.
- Dev without `DATABASE_URL` uses embedded PGlite and applies the migration itself. Production points `DATABASE_URL` at Neon and expects the migration to have been applied by the owner role. The API role must be `nexora_app` (no superuser, no bypass of row-level security). Superusers bypass RLS even when it is forced; triggers still fire for them.
- Identity is a signed session cookie. `x-actor-id` is trusted only when `NEXORA_DEV_HEADERS=true`, and that setting is refused in production. `PLATFORM_ADMIN_ACTOR_IDS` names platform operators; it does not grant financial access.

## How we work

Changes land on `main` through a pull request. Do not commit to `main` directly.

- [SDLC](docs/sdlc.md) — risk classes R0–R3, hooks, CI, Origin rules, releases, environments
- [Integration workflow](docs/github-workflow.md) — branches, Conventional Commits, CI jobs
- [Review workflow](docs/review-workflow.md) — financial, API, and UI checklists
- [Contributing](CONTRIBUTING.md) — local setup and the pull request path
- [Architecture decisions](docs/adr/README.md)

`pnpm install` enables commitlint and lint-staged. Pull requests run lint, typecheck, tests (kernel line coverage at least 90%), the web build, Playwright, `pnpm audit --prod`, and gitleaks. A diff in `packages/kernel`, `packages/db`, `apps/api`, or `.github/workflows` must check the financial review attestation. Origin does not execute the GitHub Actions file until a CI app is connected; the gap is recorded in `docs/sdlc.md`.

## Run

```bash
pnpm install
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm dev:api
pnpm dev:web
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The API listens on `http://127.0.0.1:8787`. Use the same hostname for the page and the API so the session cookie is sent (`SameSite=Lax`). `pnpm --filter @nexora/web test:e2e` runs the Playwright flows and starts both servers when they are not already up.

No secrets are required for the seeded demo. Copy `.env.example` to `.env` when you point `DATABASE_URL` at Neon or turn on a live model. Do not commit `.env`.

Apply `packages/db/migrations/0001_kernel_foundation.sql` through `0004_workspace.sql` before starting the API with `DATABASE_URL`. The demo seed runs only when `DATABASE_URL` is unset.

### Environment

| Variable                         | Role                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | Postgres connection. Unset uses in-memory PGlite and the demo seed.                                |
| `AUTH_SECRET`                    | Session signing secret, at least 32 characters. Ephemeral in local dev when unset.                 |
| `WEB_ORIGIN`                     | Comma-separated browser origins allowed to call the API. Defaults include `http://127.0.0.1:4317`. |
| `NEXORA_DEV_HEADERS`             | `true` trusts identity headers. Local only. Refused in production.                                 |
| `NEXORA_SEED_DEMO`               | `false` skips the Nazareno seed.                                                                   |
| `NEXORA_DEMO_PASSWORD`           | Demo password. Default `nexora-demo-2026`.                                                         |
| `PLATFORM_ADMIN_ACTOR_IDS`       | Platform operators. Default includes `platform-admin` outside production.                          |
| `AI_API_KEY` or `OPENAI_API_KEY` | Live copilot. Unset uses a labeled mock answer.                                                    |
| `AI_MODEL`                       | Chat model. Default `gpt-4o-mini`.                                                                 |
| `AI_BASE_URL`                    | Optional OpenAI-compatible base URL.                                                               |
| `NEXT_PUBLIC_API_URL`            | Browser API origin. Default `http://127.0.0.1:8787`.                                               |
| `API_URL`                        | Server-side health fetch for `/classic`. Default `http://127.0.0.1:8787`.                          |

## API sketch

Protected routes require `x-actor-id`, `x-region`, and, after provisioning, `x-tenant-id`. Journal posts require `Idempotency-Key`. Reversals also require `Expected-Version`.

- `POST /v1/tenants`
- `POST /v1/memberships`
- `GET /v1/entities` and `POST /v1/entities`
- `GET /v1/entities/:entityId/accounts` and `POST /v1/accounts`
- `GET /v1/entities/:entityId/periods`, `POST /v1/periods`, and `POST /v1/periods/:id/close`
- `GET /v1/entities/:entityId/journals`, `POST /v1/journals`, `GET /v1/journals/:id`, and `POST /v1/journals/:id/reverse`
- `GET /v1/entities/:entityId/periods/:periodId/statements`
- `POST /v1/valuations/dcf`
- `GET /v1/audit`

Errors use stable codes such as `FIN_UNBALANCED_JOURNAL`, `FIN_PERIOD_CLOSED`, `FIN_IMMUTABLE_RECORD`, `AUTH_SCOPE_DENIED`, and `REGION_MISMATCH`.
