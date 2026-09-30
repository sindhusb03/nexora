# Integration workflow

The forge is Origin (`sindhu-bharadwaj-dev/nexora`). `main` is the only long-lived branch. Every change lands through a pull request. Direct pushes to `main` are blocked once the owner applies the `main push` ruleset. The spec is in `.origin/rulesets/main-push.json`. Applying it needs a token scoped to write rulesets; the token that opened the SDLC pull request was not.

Branch names, commit rules, CI jobs, release, and environments are specified in [sdlc.md](sdlc.md). This file is the day-to-day path.

## Branches

Create the branch from current `main`.

| Prefix      | Use                                                    |
| ----------- | ------------------------------------------------------ |
| `feat/`     | New behavior                                           |
| `fix/`      | Defect with an existing invariant                      |
| `chore/`    | Tooling that does not change financial behavior        |
| `docs/`     | Process or product docs                                |
| `refactor/` | Structure without a behavior change                    |
| `kernel/`   | Calculation, journal, statement, FX, or valuation work |
| `db/`       | Schema, migration, trigger, or row-level security      |
| `api/`      | HTTP, auth, or audit wiring                            |
| `web/`      | Presentation only                                      |

Use a short imperative name: `kernel/year-end-dcf-golden`.

## Commits

Messages are Conventional Commits, enforced by commitlint in the `commit-msg` hook. The `pre-commit` hook formats and lints staged files and typechecks each staged package.

Never commit:

- `.env`, credentials, or connection strings
- customer financial documents, exports, or board-pack source files
- generated `node_modules`, `.next`, or `.turbo` output

## Pull requests

1. Open the PR against `main`. The template records risk class, linked issue, invariants, test evidence, screenshots for UI changes, rollback, and the financial attestation.
2. Keep the diff focused. Split R3 kernel work from unrelated UI work when both are large.
3. CI is described in [sdlc.md](sdlc.md#continuous-integration). Run the same commands locally when Origin has not yet attached an app that executes the workflow.
4. Review follows [review-workflow.md](review-workflow.md).
5. Squash-merge when the required approvals are in and the branch is up to date. The squash title should still say why. Merge commits are disallowed after the owner runs the `origin repo edit` command in [sdlc.md](sdlc.md#branch-protection).

Force-push only on the feature branch, and only before review has started or after agreeing with the reviewer. Never force-push `main`. The push ruleset blocks it once the owner creates `.origin/rulesets/main-push.json`.

## CI

Workflow: `.github/workflows/ci.yml`. Jobs: `verify`, `postgres-runtime`, `docker-images`, `financial-attestation`, `playwright`, `audit`, `secrets`.

Node.js 22 and the `packageManager` pin in the root `package.json` are the CI runtime. A PR that changes dependencies must include `pnpm-lock.yaml`.

Origin does not run this file. Required status checks stay off the ruleset until an Origin CI app reports check groups. The exact follow-up is in [sdlc.md](sdlc.md#origin-ci). The ruleset specs in `.origin/rulesets/` are the settings to apply; they are not active until the owner creates them.

## Secrets and environments

CI does not receive `DATABASE_URL` or production credentials. Database tests use embedded PGlite. Production migration stays a deliberate owner-role step.

Local, preview, staging, and production are described in [sdlc.md](sdlc.md#environments). Do not put secrets in the workflow file. The demo password and the CI-only database passwords are allowlisted in `.gitleaks.toml` because they are not production secrets.

## Hotfix

A production defect uses the same path: branch from `main`, test first, pull request, CI, review. Skip stages only when the fix is a config rollback already known to be safe. Do not patch posted data in place. Correct with a reversal into an open period.

## Dependency updates

Dependency pulls are ordinary PRs. They run lint, `verify`, audit, and secret scanning when CI executes. A major bump of `decimal.js`, `drizzle-orm`, `zod`, `hono`, or `next` is R3 or R2 according to what it can change, and needs the matching review.

`.github/dependabot.yml` is the GitHub Dependabot policy. Origin does not run it. Until a bot is connected, the owner opens the dependency PR by hand.
