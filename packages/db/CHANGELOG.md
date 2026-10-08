# @nexora/db

## 0.1.2

### Patch Changes

- 88791b8: Derive financial states from kernel statements with calculation lineage, serialize publication atomically, and validate tenant-scoped program parents. Lock period writes and posting, allow historical statements after later activity, attribute actual cash by journal, and correct opening retained earnings for prior distributions. Bump the calculation engine to fe-kernel-0.2.1 and display server-computed income in the program UI.
- Updated dependencies [88791b8]
  - @nexora/kernel@0.1.2

## 0.1.1

### Patch Changes

- 70164d4: Add argon2id passwords, magic links, optional TOTP, rotating Postgres sessions, an auth audit log, and unapplied ap-south-1 hosting templates.
- Updated dependencies [6a23642]
- Updated dependencies [32ec0c5]
  - @nexora/kernel@0.1.1
