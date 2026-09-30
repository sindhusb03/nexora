## Risk class

See `docs/sdlc.md`. Check one. The highest class touched wins. Editing CI gates is R3.

- [ ] R0 Docs or chore
- [ ] R1 Presentation only (`apps/web`)
- [ ] R2 API, identity, authorization, or audit
- [ ] R3 Kernel, ledger, schema, money, FX, statements, valuation, or CI gates

## Summary

What changed and why.

## Linked issue

Closes #. Write "None" when there is no issue.

## Invariants

Name the financial rules this PR must keep true. Write "None" only for R0.

## Test evidence

- [ ] `pnpm lint` and `pnpm format:check`
- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build` were run locally, or CI is the first run and this box stays open until it is green
- [ ] Golden tests cover any formula, journal rule, or schema invariant this PR changes
- [ ] Playwright (`pnpm --filter @nexora/web test:e2e`) when `apps/web` behavior changes

List the commands you ran and the result. List the golden test files when the class is R3:

## Screenshots

Required for a user-visible UI change. Write "None" when the diff does not change the UI.

## Rollback plan

How to revert this change without rewriting posted journals. For a migration, say whether the owner role must apply a follow-up migration.

## Financial review attestation

Required when the diff touches `packages/kernel`, `packages/db`, `apps/api`, or `.github/workflows`. Checking the line below is the author's statement that `docs/review-workflow.md` was followed. Reviewers still read the checklist.

- [ ] I completed the financial review checklist in docs/review-workflow.md
