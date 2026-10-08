# @nexora/web

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
