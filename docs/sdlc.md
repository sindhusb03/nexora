# SDLC

Delivery follows one rule: a change is not done until the Financial Kernel still has a single, testable, auditable source of truth.

This lifecycle covers `packages/kernel`, `packages/db`, `apps/api`, and `apps/web`. Product specs stay in `CLAUDE.md` and `UI-UX.md`. Git and review mechanics are in [github-workflow.md](github-workflow.md) and [review-workflow.md](review-workflow.md).

## Risk classes

Assign one class in the pull request before implementation grows. The highest class touched wins.

| Class | What it covers | Required gate |
| --- | --- | --- |
| R0 | Docs, tooling comments, copy that does not change behavior | CI green, one reviewer |
| R1 | `apps/web` presentation. The client displays kernel results and does not calculate them | CI green, one reviewer, UI checklist |
| R2 | API routes, identity, authorization, idempotency, audit emission | CI green, one reviewer, fail-closed check |
| R3 | Money, journals, periods, statements, FX, valuation, schema, row-level security, migrations, or the CI gates themselves | Golden tests, CI green, two reviewers, financial checklist attested |

R3 cannot be self-merged. The author is not one of the two approving reviewers.

## Stages

### 1. Frame

Write the outcome, the risk class, and the invariant that must remain true. If the request would create a second source of truth, accept a client-supplied total, or mutate a posted record, stop and propose a kernel-safe alternative.

### 2. Specify

Name inputs, formula or method version, and outputs. For any material number, lineage is part of the spec: source, formula version, input snapshot, calculation run, output. Schema work states tenant scope and region from the start, including when the first slice is single-entity.

### 3. Tests first

R3 calculation changes start with golden tests: known inputs, known outputs, formula version. Add an invariant test when the change can affect balance, cash roll-forward, sources and uses, ownership, or posted-journal immutability. R2 changes get an API test for the rejection path, not only the happy path.

### 4. Implement in kernel order

1. Pure domain logic in `@nexora/kernel`.
2. Persistence, constraints, and triggers in `@nexora/db`.
3. Application service and HTTP in `@nexora/api`, with tenant taken from identity, Zod validation, and an audit event for material writes.
4. UI in `@nexora/web` last. The browser proposes and displays. It does not own the number.

### 5. Verify locally

```bash
pnpm typecheck
pnpm test
pnpm build
```

Do not open a pull request with a failing golden test. Do not commit `.env` or customer financial documents.

### 6. Integrate

Open a pull request into `main` using the template. CI must pass. Review follows [review-workflow.md](review-workflow.md). Squash-merge only after the required approvals.

### 7. Operate

Migrations are applied by the database owner role before the API starts against that database. The API role stays `nexora_app` and must not bypass row-level security. A production deploy does not rewrite posted journals or reopen a closed period.

## Definition of done

- Risk class is recorded on the pull request.
- Invariants touched by the change are named.
- Golden tests cover any formula, journal rule, or schema invariant that changed.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- Authorization fails closed, and tenant scope does not come from the body or query alone.
- Material writes emit an audit event.
- New material numbers carry lineage (`calculation_run_id`, formula version, input hash, output hash, engine version) when they are calculated outputs.
- The UI, if touched, keeps draft and published visually separate and does not compute books or forecasts.

## Stop conditions

Stop and redesign when a change would:

- store money as a binary float
- accept a client total as the book or forecast figure
- update or delete a posted journal in place
- post into a closed period
- let an AI path publish without human confirmation and server re-validation
- trust a client-supplied tenant, role, or region as the only authorization check
