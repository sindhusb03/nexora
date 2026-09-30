# GitHub workflow

`main` is the only long-lived branch. Every change lands through a pull request. Direct pushes to `main` are not part of this workflow.

## Branches

Create the branch from current `main`.

| Prefix | Use |
| --- | --- |
| `feat/` | New behavior |
| `fix/` | Defect with an existing invariant |
| `kernel/` | Calculation, journal, statement, FX, or valuation work |
| `db/` | Schema, migration, trigger, or row-level security |
| `api/` | HTTP, auth, or audit wiring |
| `web/` | Presentation only |
| `docs/` | Process or product docs |
| `chore/` | Tooling that does not change financial behavior |

Use a short imperative name: `kernel/year-end-dcf-golden`.

## Commits

Commit messages state why the change exists. Keep commits reviewable. Do not mix an unrelated refactor into a financial change.

Never commit:

- `.env`, credentials, or connection strings
- customer financial documents, exports, or board-pack source files
- generated `node_modules`, `.next`, or `.turbo` output

## Pull requests

1. Open the PR against `main`. The template classifies risk and lists invariants and tests.
2. Keep the diff focused. Split R3 kernel work from unrelated UI work when both are large.
3. CI runs on the PR. See [CI](#ci).
4. Review follows [review-workflow.md](review-workflow.md).
5. Squash-merge when CI is green and the required approvals are in. The squash title should still say why.

Force-push only on the feature branch, and only before review has started or after agreeing with the reviewer. Never force-push `main`.

## CI

Workflow: `.github/workflows/ci.yml`.

| Job | When | What it does |
| --- | --- | --- |
| `verify` | Every PR and every push to `main` | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build` |
| `financial-attestation` | Pull requests | If the diff touches `packages/kernel`, `packages/db`, `apps/api`, or `.github/workflows`, the PR body must check the financial review attestation |

Node.js 22 and the `packageManager` pin in the root `package.json` are the CI runtime. The lockfile is the dependency source of truth. A PR that changes dependencies must include `pnpm-lock.yaml`.

`verify` and `financial-attestation` are the required status checks. Enable them in branch protection for `main`:

- Require a pull request before merging
- Require at least 1 approval
- Dismiss stale approvals when new commits are pushed
- Require status checks: `verify`, `financial-attestation`
- Require branches to be up to date before merging
- Do not allow bypasses for administrators on R3 paths
- Block force pushes and deletions of `main`

R3 still needs two human approvals. GitHub branch protection supplies the first required approval; the second is a team rule in [review-workflow.md](review-workflow.md) until CODEOWNERS lists real people.

## Secrets and environments

CI does not receive `DATABASE_URL` or production credentials. Database tests use embedded PGlite. Production migration stays a deliberate owner-role step, not a GitHub Actions job in this phase.

Repository secrets, when a later deploy workflow needs them, live in GitHub Environments (`staging`, `production`) with required reviewers on `production`. Do not put secrets in the workflow file.

## Hotfix

A production defect uses the same path: branch from `main`, test first, pull request, CI, review. Skip stages only when the fix is a config rollback already known to be safe. Do not patch posted data in place. Correct with a reversal into an open period.

## Dependency updates

Dependency pulls are ordinary PRs. They run the full `verify` job. A major bump of `decimal.js`, `drizzle-orm`, `zod`, `hono`, or `next` is R3 or R2 according to what it can change, and needs the matching review.
