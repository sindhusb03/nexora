# @nexora/api

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
