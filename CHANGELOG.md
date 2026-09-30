# Changelog

Product releases are tagged from `main` with [Changesets](https://github.com/changesets/changesets). Package changelogs are written beside each package when `pnpm changeset version` runs. This file is the product history.

## Unreleased

- SDLC gates: Conventional Commits, lint and format, kernel line coverage, dependency audit, secret scanning, and the Origin rules for `main`.
- `drizzle-orm` is at least `0.45.2`, and `postcss` is pinned to `8.5.28`, so `pnpm audit --prod` is clean.

## 0.1.0

Baseline imported into this repository. Financial kernel engine `fe-kernel-0.2.0`. Packages `@nexora/kernel`, `@nexora/db`, `@nexora/api`, and `@nexora/web` are at `0.1.0`. No release tag was cut for this baseline.
