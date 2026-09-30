# Financial Ecosystem

The Financial Ecosystem is a financial operating system built on one server-side Financial Kernel. This repository currently holds the Gate G0 foundation: deterministic accounting, statements, valuation math, immutable posted records, and tenant isolation.

The end-to-end build contract is [docs/MASTER_IMPLEMENTATION.md](docs/MASTER_IMPLEMENTATION.md). Presentation rules are in [UI-UX.md](UI-UX.md).

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

## What this phase contains

- `@nexora/kernel` — pure calculation: money in integer minor units, journal balance, three-statement derivation, year-end Gordon DCF, FX translation, formula graphs, publication rules, intercompany elimination identity.
- `@nexora/db` — Postgres schema, append-only audit, posted-journal triggers, forced row-level security, and a Drizzle store.
- `@nexora/api` — Hono API. Roles come from membership rows, never from client headers. Idempotency keys and `Expected-Version` are enforced on the writes that need them.
- `@nexora/web` — a Next.js shell that displays kernel health. It does not import the kernel and does not calculate.

Not in this phase: AI agents, Excel, consolidation ownership graphs, NCI, debt schedules, cap tables, LBO, board packs, and workflow UI.

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
- Identity is a header seam (`x-actor-id`) plus `PLATFORM_ADMIN_ACTOR_IDS` until Better Auth issues a tenant-scoped session. Do not trust a role header. Better Auth is the intended issuer because the kernel and residency boundary should stay in our control.

## How we work

- [SDLC](docs/sdlc.md) — risk classes R0–R3, test-first kernel changes, definition of done
- [GitHub workflow](docs/github-workflow.md) — `main` via pull request, CI, branch protection
- [Review workflow](docs/review-workflow.md) — financial, API, and UI checklists

Pull requests run typecheck, tests, and the web build. A diff in `packages/kernel`, `packages/db`, `apps/api`, or `.github/workflows` must check the financial review attestation.

## Run

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev:api
pnpm dev:web
```

The API listens on `http://localhost:8787`. The web shell reads `API_URL`, defaulting to that address.

Copy `.env.example` to `.env` before using Neon. Do not commit `.env`.

Apply `packages/db/migrations/0001_kernel_foundation.sql` to an empty database before starting the API with `DATABASE_URL`.

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
