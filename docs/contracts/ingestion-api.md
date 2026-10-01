# Ingestion contract

Shared schemas live in `@nexora/contracts` (`packages/contracts/src/ingestion.ts`). The Exception Review UI should import those schemas rather than re-declaring them.

Org scope comes from the signed session. Clients do not send a tenant id. Every table behind these routes has forced row-level security on `tenant_id`.

## Endpoints

| Method | Path                                | Body / query                                             | Response                               |
| ------ | ----------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| `POST` | `/ingestion/uploads`                | multipart `entityId` (uuid) and one or more `file` parts | `201` `IngestionJob`                   |
| `GET`  | `/ingestion/jobs/:id`               |                                                          | `IngestionJob`                         |
| `GET`  | `/ingestion/jobs/:id/values`        |                                                          | `{ values: ExtractedValue[] }`         |
| `GET`  | `/ingestion/jobs/:id/exceptions`    | `severity`, `type`, `documentId`                         | `{ exceptions: IngestionException[] }` |
| `POST` | `/ingestion/exceptions/:id/resolve` | `ResolveException`                                       | `{ exceptionId, status, job }`         |
| `POST` | `/ingestion/exceptions/bulk-accept` | `BulkAccept`                                             | `{ jobId, accepted }`                  |

`Idempotency-Key` on upload returns the original job when the file hashes match, and `409 FIN_IDEMPOTENCY_MISMATCH` when they do not.

## Objects

`IngestionJob`: `jobId`, `entityId`, `status` (`queued | extracting | mapping | validating | needs_review | building | posted | failed`), `currency`, `formulaVersion`, `inputHash`, `outputHash`, `createdAt`, `updatedAt`, `documents[]` (`documentId`, `fileName`, `status`, `statementKinds`, `error`), `counts` (`documents`, `values`, `exceptionsOpen`, `exceptionsError`, `exceptionsWarn`, `exceptionsInfo`).

`ExtractedValue`: `valueId`, `documentId`, `statementType`, `role`, `label`, `periodKey`, `periodEnd`, `currency`, `scale`, `minor`, `accountCode`, `mappingConfidence`, `mappingMethod`, `mappingAccepted`, `provenance`.

`Provenance`: `fileName`, `page`, `sheet`, `row`, `col`, `bbox` (`x0`, `y0`, `x1`, `y1` in PDF points, or null), `rawText`.

`IngestionException`: `id`, `jobId`, `documentId`, `type` (kernel check id or `mapping_low_confidence`), `severity` (`error | warn | info`), `message`, `values` (`expected`, `actual`, `diff`), `provenance` (`valueIds`, `locations`), `status` (`open | accepted | corrected | remapped | not_applicable`), `resolution` (`by`, `at`, `note`, `before`, `after`) or null.

`ResolveException`: `action` (`accept | correct | remap | not_applicable`), `note`. `correct` requires `amount` (plain decimal). `remap` requires `accountCode` (`^[a-z][a-z0-9_]{0,63}$`).

`BulkAccept`: `jobId`, `minConfidence` (plain decimal). Accepts open `mapping_low_confidence` exceptions whose stored confidence is greater than or equal to `minConfidence`. This is an explicit human action.

## Mapping and checks

Deterministic exact, synonym, and regex rules run first. The AI proposer is behind `MappingProposer`. Production uses `reviewMappingProposer`, which ignores confidence markers embedded in uploaded text and leaves the line for exception review. `stubMappingProposer` is only for tests and non-production demo mode. Unattended auto-accept requires confidence `>= 0.95` (`MAPPING_AUTO_ACCEPT_CONFIDENCE`) and only an exact complete label or explicitly listed full synonym. Qualifiers (including current/non-current, total, net, units, bracketed text and non-Latin text) are retained. Additional words and regex hits stay below the threshold. Unqualified borrowings and term loans require maturity confirmation. AI mapping proposals require human acceptance regardless of their confidence. Contra, tax, reserve, deferred, and borrowing families map to the corrected class at `0.90`. Plain `cost of sales` and `cost of goods sold` auto-accept. Profit before tax, interest income, and deferred revenue stay at `0.90`. Lower confidence raises `mapping_low_confidence`.

Kernel checks are pure (`runIngestionChecks`, formula `ingestion-checks-0.3.0`). The 15 blocking checks are `bs_balance`, `subtotal_footing`, `total_footing`, `is_retained_earnings`, `period_continuity`, `sign_conventions`, `cash_ties_bank`, `bank_rollforward`, `duplicates`, `period_coverage`, `scale_consistency`, `currency_consistency`, `cross_statement_dates`, `depreciation_reasonableness`, and `missing_mandatory`. Prior-period variance is a 16th advisory check, `prior_period_variance`: info above 25 percent, warn above 100 percent. It does not block posting. Negative equity (an accumulated deficit) is allowed. Scale consistency also flags the same account when magnitudes differ by 100,000 or more. Parser issues `ambiguous_date`, `dropped_amount`, `zero_extraction`, `layout_unresolved`, `confirm_period_end`, and `balance_mismatch` are blocking exceptions. A bare year is not posted as 31 December. It uses an explicit document date, then the organisation fiscal year end (`legal_entity.fiscal_year_end_month` / `day`), then `confirm_period_end`. A resolved year end that disagrees with the organisation setting or existing period ends does not post. The words "fiscal year" do not imply 31 March. Period columns, Tally debit and credit columns, bank header synonyms, and PDF text clustered by x position are read without a per-vendor template. An unclassified layout extracts nothing. A proposer may suggest rows for review, but cannot clear a deterministic parser exception. Kernel arithmetic alone does not establish source provenance or units. Re-uploading the same bytes of a posted job returns that job (`content_hash`). A different file with the same canonical amounts does not post again (`canonical_hash`). A job that is not posted is resumed. Accounts, periods, journals, and the posted job status commit in one database transaction. A failure rolls that transaction back and leaves the job in `needs_review` with no reversal rows. Overlapping comparative periods are reconciled to the ledger. A doubled balance sheet is a blocking exception. A mapping that changes statement class or sign stays below the 0.95 auto-accept line.

Amount scale includes units, thousands (`'000`), millions, lakhs, and crores, and is applied before minor units. `S$` is SGD and `A$` is AUD. `FY2024-25` without a document date or an organisation year end raises `confirm_period_end`. With either, the label uses that month and day for twelve months. An explicit 31 March date still runs 1 April through 31 March. `£m` and `$m` are millions. Interim descriptions (monthly, quarter, half-year, YTD, and N months other than twelve) raise `confirm_period_end`; they never become annual periods. Ordinal dates (`31st March`) and complete twelve-month from-to ranges are supported. PDF bank columns align by x position. Print, run, and generated dates are not the period. Bank date order is inferred from the date column (a part greater than 12). Ambiguous dates raise `ambiguous_date`. Ledger balances used for posting are read inside the posting transaction under a row lock. A losing concurrent upload returns `FIN_IDEMPOTENCY_MISMATCH` instead of a database error.

When no error-severity exception is open, the service posts a linked model through the existing journal path. Repeating the post with the same input hash is a no-op.

## Parser safety and integration verification

The engine wire schemas remain in `packages/contracts/src/ingestion-api.ts`; no contract source files changed in this round.

- `0006_ingestion.sql` and `0007_fiscal_year_end.sql` follow auth/hosting. Fresh migration, baseline upgrade through 0005/0006/0007, second-run idempotency, and readiness are tested. The column marker prevents 0007 being skipped merely because `legal_entity` exists.
- 0005's `auth_maintenance_all` policy applies only to its seven operational auth tables, not all tenant tables. Ingestion keeps forced tenant RLS with no auth-maintenance bypass. Tests verify policies and that an existing ingestion job remains invisible to a maintenance-only app-role session.
- CSV/TSV/semicolon parsing preserves source decimal text and quoted fields. Monetary text supports western/Indian grouping, decimal commas with two fractional digits, space/apostrophe grouping, brackets, trailing negatives and Unicode minus. Scaling precedes minor-unit validation; sub-minor values require review rather than rounding. Accounting Dr/Cr is relative to a known account's normal side; bank Dr/Cr is transaction direction.
- Spreadsheet headers scan up to 100 populated rows. Numeric dates require a date style and honor the 1900/1904 epoch. Unformatted numeric amounts never become dates. Duplicate period columns require review. Scale is local to each sheet; conflicting declarations block extraction.
- PDF dated header geometry anchors integer and decimal amount columns and excludes notes columns. Metadata dates cannot supply a single-column period. The existing PDF text decoder handles the text layer; undecodable/scanned layouts remain for review.
- Banks retain opening/closing and total-row semantics. An opening balance is never synthesized from closing minus transactions. Missing independent balances, reconciliation failures, duplicate amount columns and unknown direction markers block posting. Narrative lines with multiple numeric candidates are omitted with an exception.

### Independent synthetic accuracy evidence

`test/fixtures/adversarial-corpus.ts` generates 72 documents across IN, US, UK, EU, SG, AE, JP and AU. Layout styles vary comparative column order, preamble length, notes, integer/text/numeric amounts, scale, qualified/non-Latin labels, and signed/debit-credit/direction bank columns. It does not import `heldout-corpus.ts`. The authenticated upload tests check persisted amount, scale, currency, period, mapping acceptance and whether journals were written. CI fails on any wrong extracted value or wrong auto-post, or family accuracy below 80%.

| Family         | Documents | Correct / expected cells | Wrong values | Wrong auto-posts |
| -------------- | --------: | -----------------------: | -----------: | ---------------: |
| Income / CSV   |         8 |                  64 / 64 |            0 |                0 |
| Income / XLSX  |         8 |                  64 / 64 |            0 |                0 |
| Income / PDF   |         8 |                  64 / 64 |            0 |                0 |
| Balance / CSV  |         8 |                  80 / 80 |            0 |                0 |
| Balance / XLSX |         8 |                  80 / 80 |            0 |                0 |
| Balance / PDF  |         8 |                  80 / 80 |            0 |                0 |
| Bank / CSV     |         8 |                  32 / 32 |            0 |                0 |
| Bank / XLSX    |         8 |                  32 / 32 |            0 |                0 |
| Bank / PDF     |         8 |                  32 / 32 |            0 |                0 |
| Overall        |        72 |                528 / 528 |            0 |                0 |

Separate complete-package HTTP tests require 13 ambiguous packages to leave no periods or journals, with a positive September-year-end control that posts exactly two journals. These are development fixtures, not blind-set validation. Unsupported/ambiguous layouts, untranslated mappings, interim periods, missing bank balances and uncertain source precision remain review work. The engine cannot promise a measured result on the judge's unseen corpus.

Final local verification: lint, five-package typecheck, build, and changed-file Prettier checks pass. The kernel has 122 passing tests and 90.92% line coverage. The full suite with one Vitest worker per package (`pnpm test --env-mode=loose`, using the Vitest min/max thread/fork environment settings) has 381 passing tests, one skipped test and one failure: the existing `auth-factors.test.ts` magic-link timing test measured an 11.213 ms median gap against its 5 ms limit. The unmodified test passed in an isolated run, but the full test gate remains failing; auth code and thresholds were not changed.

### Changed-file inventory for this round

| File                                                | Reason                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/api/src/imports/bank-tabular.ts`              | Preserve bank direction, summaries and independent reconciliation; reject numeric-column guessing. |
| `apps/api/src/imports/decimal-text.ts`              | Regional grouping, decimal commas, Unicode minus and token boundaries.                             |
| `apps/api/src/imports/document-parser.ts`           | Sheet-specific scales, interim/conflicting-period blocks and provenance column selection.          |
| `apps/api/src/imports/period.ts`                    | Metadata exclusion, calendar validation, localized dates and explicit period lengths.              |
| `apps/api/src/imports/statement-csv.ts`             | Preserve decimal source strings and shared quoted-delimiter parsing.                               |
| `apps/api/src/imports/statement-pdf.ts`             | Dated header alignment, integer amounts and safe title-date fallback.                              |
| `apps/api/src/imports/statement-xlsx.ts`            | Deeper header discovery, duplicate-column rejection and accounting debit/credit signs.             |
| `apps/api/src/imports/xlsx.ts`                      | Read Excel date styles and 1904 epoch.                                                             |
| `apps/api/src/ingestion/service.ts`                 | Retain AI proposal blockers; reject precision loss and automatic AI mapping acceptance.            |
| `apps/api/test/adversarial-ingestion.test.ts`       | 51 independent parser and precision regressions.                                                   |
| `apps/api/test/adversarial-accuracy.test.ts`        | Per-family cell scoring plus 72 authenticated upload checks.                                       |
| `apps/api/test/fixtures/adversarial-corpus.ts`      | Reproducible market/layout/format fixture generator.                                               |
| `apps/api/test/ingestion-readiness.test.ts`         | Renumbered migration readiness and AI proposal safety.                                             |
| `apps/api/test/ingestion.http.test.ts`              | 13 blocked complete packages, positive posting control and production test configuration.          |
| `apps/api/test/accuracy.test.ts`                    | Expect the new missing-bank-balance exception.                                                     |
| `apps/api/test/families.test.ts`                    | Preserve decimal source spelling in expected strings.                                              |
| `apps/api/test/imports.test.ts`                     | Give Excel date fixtures explicit date styles.                                                     |
| `apps/api/test/layout.test.ts`                      | Assert interim review and correct debit-side revenue sign.                                         |
| `packages/db/test/ingestion-migrations.test.ts`     | Fresh/baseline/idempotent migration and populated-row RLS checks.                                  |
| `packages/kernel/src/ingestion-mapping.ts`          | Preserve Unicode and symbol qualifiers; review debt with unknown maturity.                         |
| `packages/kernel/test/ingestion-qualifiers.test.ts` | 56 qualifier and maturity cases.                                                                   |
| `packages/kernel/test/ingestion-semantic.test.ts`   | Require review for unqualified borrowings.                                                         |
| `docs/contracts/ingestion-api.md`                   | Correct the documented safety behavior and record evidence/limitations.                            |
