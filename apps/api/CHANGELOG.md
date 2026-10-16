# @nexora/api

## 0.1.3

### Patch Changes

- 9bdfa44: Derive group translation and elimination trial balances from posted activity through the period end. Balance-sheet accounts are cumulative, current-period income stays on the income accounts, and prior-period earnings roll into retained earnings. Reject caller-supplied trial balances.
- 1705d3b: Gate demonstration planning evidence, require independent bank imports for reconciliation, select tenant-scoped historical snapshots, and audit conditional review decisions. Target explicit tenants for flags and grant support membership and evidence atomically. Require exact numeric grounding and resolvable citations, separating document context from kernel facts, and record live model corpus metadata.
- 1c7dab5: Bank and statement ingestion (blind-r6): keep a printed closing balance only when it reconciles with opening plus transactions, or when the running balances are themselves inconsistent (which goes to review); drop a closing that contradicts reconciling running balances. Add signed single-amount columns, Dutch signed decimals, Swiss German preambles and headers, PDF B/F and C/F rows, counterparty-first descriptions, and localized Swiss German, Portuguese, Spanish and Korean statement titles and periods.
- 6fafef5: Classify each cash leg by the accounts it settles, keep opening balances and direct retained earnings inside the statements, and apply the disposal and lease cash-flow rules. Share one ISO 4217 minor-unit scale and add exact allocation.
- Updated dependencies [9bdfa44]
- Updated dependencies [6fd7980]
- Updated dependencies [1705d3b]
- Updated dependencies [6fafef5]
  - @nexora/db@0.1.3
  - @nexora/kernel@0.2.0
  - @nexora/contracts@0.3.0

## 0.1.2

### Patch Changes

- edfcb59: Disable signup by default, reserve administrative identities, and require explicit acknowledgement when signup coexists with platform admins. Enforce support expiry before tenant access and session rotation, removing expired memberships with audit events. Check both IP limits before reading credential bodies, cap them at 16 KiB, and parse JSON once.
- 88791b8: Derive financial states from kernel statements with calculation lineage, serialize publication atomically, and validate tenant-scoped program parents. Lock period writes and posting, allow historical statements after later activity, attribute actual cash by journal, and correct opening retained earnings for prior distributions. Bump the calculation engine to fe-kernel-0.2.1 and display server-computed income in the program UI.
- Updated dependencies [88791b8]
  - @nexora/kernel@0.1.2
  - @nexora/db@0.1.2

## 0.1.1

### Patch Changes

- 70164d4: Add argon2id passwords, magic links, optional TOTP, rotating Postgres sessions, an auth audit log, and unapplied ap-south-1 hosting templates.
- 32ec0c5: Recognize shared-year month ranges and localized fiscal column labels from document evidence. Resolve current/prior columns using explicit statement dates or configured fiscal year ends; retain ambiguous years, interim ranges and conflicting annual calendars as open period exceptions.
- 6a23642: Resolve bank statement columns and dates from document evidence, reconcile summaries and running balances, and retain ambiguity as review exceptions.
- 6a23642: Read localized financial statement layouts with exact multilingual labels, stacked period headers, explicit units and document-wide number evidence. Keep unknown labels and ambiguous layouts in review.
- 6a23642: Resolve statement periods from explicit date ranges, localized titles, and column headers. Preserve dated comparative columns and hold ambiguous, conflicting, or interim periods for confirmation.
- d53446b: Parse CSV amounts exactly and flag ambiguous inputs for review. Authorize file imports and reuse stored results before parsing. Display currency minor units correctly, neutralize spreadsheet formulas in exports, and clear uploaded data when identity changes. Make magic-link timing regressions deterministic and require explicit production boot-refusal evidence in CI.
- 32ec0c5: Recognize multilingual bank columns, evidence-backed headerless tables, split PDF headers and page-scoped grouped dates. Reject malformed row widths and ambiguous layouts, preserving Decimal reconciliation and open review exceptions.
- 6a23642: Preserve bank transactions with type codes, withhold inferred balances after incomplete or unreconciled extraction, and normalize numeric Excel bank cells using decimal text.
- 32ec0c5: Extract independently titled statement blocks and semantic net columns across tabular and text-PDF uploads. Reconcile gross/depreciation/net and T-format side and group totals exactly in the Decimal kernel, exclude transfers from account lines, and hold ambiguous layouts for review.
- Updated dependencies [70164d4]
- Updated dependencies [6a23642]
- Updated dependencies [22f3784]
- Updated dependencies [32ec0c5]
  - @nexora/db@0.1.1
  - @nexora/kernel@0.1.1
  - @nexora/contracts@0.2.0
