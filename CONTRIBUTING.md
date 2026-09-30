# Contributing

`main` is protected. Work on a short-lived branch and open a pull request. The lifecycle, risk classes, and environments are in [docs/sdlc.md](docs/sdlc.md). Review checklists are in [docs/review-workflow.md](docs/review-workflow.md).

## Setup

```bash
pnpm install
```

`pnpm install` enables Husky. The `pre-commit` hook runs lint-staged (Prettier, ESLint, and typecheck of each staged package). The `commit-msg` hook requires a [Conventional Commit](https://www.conventionalcommits.org/):

```text
feat: add a cash alert when the minimum is breached
fix(kernel): keep income statements to period movement
chore: refresh the lockfile
```

Prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`. Calculation, schema, API, and presentation branches may also use `kernel/`, `db/`, `api/`, and `web/`.

## Before opening a pull request

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

A change under `apps/web` also runs `pnpm --filter @nexora/web test:e2e`.

Use the pull request template. Record one risk class. Check the financial review attestation when the diff touches `packages/kernel`, `packages/db`, `apps/api`, or `.github/workflows`.

A behavior change in a package needs a changeset:

```bash
pnpm changeset
```

Docs, CI, and formatting do not.

## Issues

Bug and feature templates live in `.github/ISSUE_TEMPLATE/`. Origin does not render GitHub issue forms itself; copy the headings into the Origin issue if the form does not appear.
