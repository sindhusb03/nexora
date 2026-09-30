# SDLC

Delivery follows one rule: a change is not done until the Financial Kernel still has a single, testable, auditable source of truth.

This lifecycle covers `packages/kernel`, `packages/db`, `apps/api`, and `apps/web`. Product specs stay in `CLAUDE.md` and `UI-UX.md`. Forge mechanics are in [github-workflow.md](github-workflow.md). Review checklists are in [review-workflow.md](review-workflow.md). Accepted technical decisions are in [adr](adr/README.md).

The forge is the private Origin repository `sindhu-bharadwaj-dev/nexora`. Do not commit directly to `main`.

## Risk classes

Assign one class in the pull request before implementation grows. The highest class touched wins.

| Class | What it covers                                                                                                          | Required gate                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| R0    | Docs, tooling comments, copy that does not change behavior                                                              | CI green, one reviewer                                              |
| R1    | `apps/web` presentation. The client displays kernel results and does not calculate them                                 | CI green, one reviewer, UI checklist                                |
| R2    | API routes, identity, authorization, idempotency, audit emission                                                        | CI green, one reviewer, fail-closed check                           |
| R3    | Money, journals, periods, statements, FX, valuation, schema, row-level security, migrations, or the CI gates themselves | Golden tests, CI green, two reviewers, financial checklist attested |

R3 cannot be self-merged. The author is not one of the two approving reviewers.

## Branches

Trunk-based development. `main` is the only long-lived branch. Create a short-lived branch from current `main`:

| Prefix      | Use                                               |
| ----------- | ------------------------------------------------- |
| `feat/`     | New behavior                                      |
| `fix/`      | Defect with an existing invariant                 |
| `chore/`    | Tooling that does not change financial behavior   |
| `docs/`     | Process or product docs                           |
| `refactor/` | Structure without a behavior change               |
| `kernel/`   | Calculation, journal, statement, FX, or valuation |
| `db/`       | Schema, migration, trigger, or row-level security |
| `api/`      | HTTP, auth, or audit wiring                       |
| `web/`      | Presentation only                                 |

## Commits

Commits use [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`). Commitlint rejects anything else. Husky runs on `pnpm install`:

- `commit-msg` runs commitlint.
- `pre-commit` runs lint-staged: Prettier, ESLint, then `typecheck` in each staged workspace package (`@nexora/kernel`, `@nexora/db`, `@nexora/api`, `@nexora/web`).

Never commit `.env`, credentials, customer financial documents, or generated `node_modules`, `.next`, or `.turbo` output.

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
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` includes `@nexora/kernel` line coverage. The kernel gate is at least 90% lines. Do not open a pull request with a failing golden test. Do not commit `.env` or customer financial documents.

### 6. Integrate

Open a pull request into `main` using the template. The template asks for a summary, a linked issue, the risk class, test evidence, screenshots when the UI changes, a rollback plan, and the financial review attestation. CI must pass. Review follows [review-workflow.md](review-workflow.md). Squash-merge only after the required approvals.

### 7. Operate

Migrations are applied by the database owner role before the API starts against that database. The API role stays `nexora_app` and must not bypass row-level security. A production deploy does not rewrite posted journals or reopen a closed period.

## Continuous integration

Workflow: `.github/workflows/ci.yml`. It is GitHub Actions syntax and runs on every pull request and on pushes to `main`.

| Job                     | What it does                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `verify`                | Frozen pnpm install, ESLint, Prettier, typecheck, unit and API tests, kernel line coverage, production build |
| `postgres-runtime`      | Migrate twice on Postgres 17, boot as `nexora_app`, refuse superuser and missing `DATABASE_URL`              |
| `docker-images`         | Build the API and web images                                                                                 |
| `financial-attestation` | Fail the pull request when a protected-path diff lacks the attestation line                                  |
| `playwright`            | Browser flows for the studio                                                                                 |
| `audit`                 | `pnpm audit --prod`                                                                                          |
| `secrets`               | gitleaks, with the demo and CI-only credentials allowlisted                                                  |

Protected paths are `packages/kernel/`, `packages/db/`, `apps/api/`, and `.github/workflows/`. The attestation line is exactly:

```text
- [x] I completed the financial review checklist in docs/review-workflow.md
```

pnpm is cached with `actions/setup-node` (`cache: pnpm`). Node.js 22 and the `packageManager` pin are the runtime. The lockfile is the dependency source of truth.

### Origin CI

Origin does not execute GitHub Actions workflows. Its CI state is check-run groups posted by an app actor (`app_…`). The Origin CLI has no workflow runner. Until an Origin CI app is installed, the jobs above are defined and can be run locally, and they are not yet required status checks on `main`.

To enforce them:

1. Install an Origin app that checks out the commit and runs the same commands as `.github/workflows/ci.yml` (or a runner that executes that file).
2. Have the app post one check group per job: `verify`, `postgres-runtime`, `docker-images`, `financial-attestation`, `playwright`, `audit`, `secrets`.
3. Read the app actor id and group keys from a finished pull request: `origin pr checks <number> --json id,name,status,group`.
4. Add a `require_status_checks` rule to the `main merge` ruleset with `origin ruleset update`, using those actor ids and group keys. Origin cannot derive them from GitHub check names.

## Branch protection

`main` should be protected with two Origin rulesets. The specs checked into this repo are the source of truth. They are not active yet: the token available when this change was opened can read the repository and list rulesets, and Origin rejected `ruleset create` and `repo edit` with "Your Origin token is not scoped for this operation". That is a token scope limit, not a missing repository. The owner applies them:

- [.origin/rulesets/main-merge.json](../.origin/rulesets/main-merge.json) — kind `merge_branch`. Rules: `pull_request` with `requiredApprovingReviewCount` 1, and `require_branch_up_to_date`. No bypass actors.
- [.origin/rulesets/main-push.json](../.origin/rulesets/main-push.json) — kind `push_branch`. Rules: `block_direct_updates`, `required_linear_history`, `non_fast_forward` (blocks force pushes), `deletion` (blocks deleting `main`). No bypass actors.

Reapply with:

```bash
origin ruleset create -R sindhu-bharadwaj-dev/nexora --input .origin/rulesets/main-merge.json
origin ruleset create -R sindhu-bharadwaj-dev/nexora --input .origin/rulesets/main-push.json
```

Repository merge settings (not ruleset rules; Origin cannot restrict merge method inside a ruleset). Apply the same way, from an owner token:

```bash
origin repo edit sindhu-bharadwaj-dev/nexora --allow-squash-merge --no-allow-merge-commit --delete-branch-on-merge
```

- Squash merge allowed
- Merge commits disallowed
- Delete head branch on merge

That keeps `main` linear, matching `required_linear_history`. Until the owner runs it, the repository still allows merge commits (`allowMergeCommit: true` at the time of this change) and does not delete the head branch on merge.

What these rules do not do, and where that lives:

| Control                                                                                                                   | Where it is enforced                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pull request required, one approval, up-to-date branch, linear history, no direct push, no force push, no deleting `main` | Specs in `.origin/rulesets/` and the `origin repo edit` command above. Not enforced until an owner token applies them              |
| Second R3 approval, author is not an approver                                                                             | Team rule in [review-workflow.md](review-workflow.md). Origin's pull-request rule counts approvals; it does not exclude the author |
| Passing CI                                                                                                                | Documented here. Not a ruleset rule until an Origin CI app actor id exists                                                         |
| Financial attestation checkbox                                                                                            | GitHub Actions job `financial-attestation`, when that workflow runs                                                                |
| CODEOWNERS                                                                                                                | Ownership record in `.github/CODEOWNERS`. `requireCodeOwnerReview` stays off until Origin can resolve the owner                    |
| Dependabot                                                                                                                | `.github/dependabot.yml` is present. Origin does not run Dependabot                                                                |
| Dismiss stale reviews                                                                                                     | Not enabled. Origin stores that GitHub policy and then fails merge evaluation with `unsupported_policy`                            |

R3 still needs two human approvals. After the owner applies the merge ruleset, it supplies the first required approval. The second is the team rule until CODEOWNERS lists people Origin can resolve.

## Release

Versions follow semantic versioning through Changesets. Packages are private. `privatePackages.version` and `privatePackages.tag` are on, so a version bump still tags.

1. On the pull request, run `pnpm changeset` when package behavior changes. Docs and CI do not need one.
2. After the pull request is on `main`, run `pnpm changeset version`. That updates package versions and writes each package `CHANGELOG.md`. Commit with `chore: version packages`.
3. Open that commit as a pull request, merge it, then on `main` run `pnpm changeset tag` and `git push --follow-tags`.
4. The product history is [CHANGELOG.md](../CHANGELOG.md). Do not publish these packages to the public npm registry.

`.github/workflows/release.yml` is the GitHub Actions form of steps 2 and 3. Origin will not run it until a CI app does. Tag pushes are not blocked by the `main` push ruleset.

The current baseline is package `0.1.0` and engine `fe-kernel-0.2.0`. It was not tagged.

## Environments

| Environment | Database                                                                | Secrets                                                                      | What runs                                                                                                               |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Local       | Embedded PGlite when `DATABASE_URL` is unset                            | None. Demo password only                                                     | `pnpm dev:api`, `pnpm dev:web`. Demo seed when not production and `NEXORA_SEED_DEMO` is not `false`                     |
| Preview     | Not deployed by this repository yet                                     | None in git                                                                  | Intended: the pull-request revision, demo data only, no customer books                                                  |
| Staging     | Postgres in the tenant home region. Owner role applies migrations first | Origin or GitHub environment `staging`, required reviewer before use         | API as `nexora_app`. No demo seed                                                                                       |
| Production  | Postgres. Owner role applies migrations before the API starts           | Environment `production`, required reviewer. `NEXORA_DEV_HEADERS` is refused | No rewrite of posted journals. No reopen of a closed period. `PLATFORM_ADMIN_ACTOR_IDS` does not grant financial access |

CI does not receive `DATABASE_URL` or production credentials. Database tests use PGlite. The Postgres CI job uses passwords that exist only inside that job.

## Quality gates

- ESLint and Prettier cover the monorepo (`pnpm lint`, `pnpm format:check`).
- TypeScript is strict in `tsconfig.base.json` (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, unused locals and parameters). Every package extends that base.
- Kernel line coverage is at least 90%.
- `.github/CODEOWNERS` assigns the tree to `@sindhu-bharadwaj-dev`.
- Dependency review is `pnpm audit --prod` in CI, plus `.github/dependabot.yml` for the day a GitHub connection runs it.
- [SECURITY.md](../SECURITY.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) describe reporting and the contribution path.

## Definition of done

- Risk class is recorded on the pull request.
- Invariants touched by the change are named.
- Golden tests cover any formula, journal rule, or schema invariant that changed.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
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
