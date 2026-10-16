# @nexora/web

## 0.2.2

### Patch Changes

- 6fd7980: Patch Next.js to 15.5.27 and pin source-map-js to 1.2.2 or later to clear production audit advisories GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p, and GHSA-68fv-2mgg-jv7q.
- 6fafef5: Classify each cash leg by the accounts it settles, keep opening balances and direct retained earnings inside the statements, and apply the disposal and lease cash-flow rules. Share one ISO 4217 minor-unit scale and add exact allocation.
- 1e3a5a8: Add a main-app sign-up page and a first-run stepper for company name, base currency, and fiscal year end.
- Updated dependencies [6fafef5]
  - @nexora/currency@0.2.0
  - @nexora/contracts@0.3.0

## 0.2.1

### Patch Changes

- 88791b8: Derive financial states from kernel statements with calculation lineage, serialize publication atomically, and validate tenant-scoped program parents. Lock period writes and posting, allow historical statements after later activity, attribute actual cash by journal, and correct opening retained earnings for prior distributions. Bump the calculation engine to fe-kernel-0.2.1 and display server-computed income in the program UI.

## 0.2.0

### Minor Changes

- 22f3784: Add the ingestion review contract and an exception queue that proposes resolutions without posting to the ledger.

### Patch Changes

- 70164d4: Add argon2id passwords, magic links, optional TOTP, rotating Postgres sessions, an auth audit log, and unapplied ap-south-1 hosting templates.
- d53446b: Parse CSV amounts exactly and flag ambiguous inputs for review. Authorize file imports and reuse stored results before parsing. Display currency minor units correctly, neutralize spreadsheet formulas in exports, and clear uploaded data when identity changes. Make magic-link timing regressions deterministic and require explicit production boot-refusal evidence in CI.
- Updated dependencies [22f3784]
  - @nexora/contracts@0.2.0
