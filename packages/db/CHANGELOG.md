# @nexora/db

## 0.1.3

### Patch Changes

- 9bdfa44: Derive group translation and elimination trial balances from posted activity through the period end. Balance-sheet accounts are cumulative, current-period income stays on the income accounts, and prior-period earnings roll into retained earnings. Reject caller-supplied trial balances.
- 6fd7980: Patch Next.js to 15.5.27 and pin source-map-js to 1.2.2 or later to clear production audit advisories GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p, and GHSA-68fv-2mgg-jv7q.
- 1705d3b: Gate demonstration planning evidence, require independent bank imports for reconciliation, select tenant-scoped historical snapshots, and audit conditional review decisions. Target explicit tenants for flags and grant support membership and evidence atomically. Require exact numeric grounding and resolvable citations, separating document context from kernel facts, and record live model corpus metadata.
- 6fafef5: Classify each cash leg by the accounts it settles, keep opening balances and direct retained earnings inside the statements, and apply the disposal and lease cash-flow rules. Share one ISO 4217 minor-unit scale and add exact allocation.
- Updated dependencies [1705d3b]
- Updated dependencies [6fafef5]
  - @nexora/kernel@0.2.0
  - @nexora/currency@0.2.0

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
