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

Deterministic exact, synonym, and regex rules run first. The AI proposer is behind `MappingProposer`. Production uses `reviewMappingProposer`, which ignores confidence markers embedded in uploaded text and leaves the line for exception review. `stubMappingProposer` is only for tests and non-production demo mode. Unattended auto-accept requires confidence `>= 0.95` (`MAPPING_AUTO_ACCEPT_CONFIDENCE`) and only an exact or near-exact chart synonym. Neutral extras are `total`, `net`, `trade`, `other`, `current`, `non-current`, `the`, `and`, and currency or unit markers. Any other token, including a regex hit, stays at `0.90`. Contra, tax, reserve, deferred, and borrowing families map to the corrected class at `0.90`. Plain `cost of sales` and `cost of goods sold` auto-accept. Profit before tax, interest income, and deferred revenue stay at `0.90`. Lower confidence raises `mapping_low_confidence`.

Kernel checks are pure (`runIngestionChecks`, formula `ingestion-checks-0.3.0`). The 15 blocking checks are `bs_balance`, `subtotal_footing`, `total_footing`, `is_retained_earnings`, `period_continuity`, `sign_conventions`, `cash_ties_bank`, `bank_rollforward`, `duplicates`, `period_coverage`, `scale_consistency`, `currency_consistency`, `cross_statement_dates`, `depreciation_reasonableness`, and `missing_mandatory`. Prior-period variance is a 16th advisory check, `prior_period_variance`: info above 25 percent, warn above 100 percent. It does not block posting. Negative equity (an accumulated deficit) is allowed. Scale consistency also flags the same account when magnitudes differ by 100,000 or more. Parser issues `ambiguous_date`, `dropped_amount`, `zero_extraction`, `layout_unresolved`, `confirm_period_end`, and `balance_mismatch` are blocking exceptions. A bare year is not posted as 31 December. It uses an explicit document date, then the organisation fiscal year end (`legal_entity.fiscal_year_end_month` / `day`), then `confirm_period_end`. A resolved year end that disagrees with the organisation setting or existing period ends does not post. The words "fiscal year" do not imply 31 March. Period columns, Tally debit and credit columns, bank header synonyms, and PDF text clustered by x position are read without a per-vendor template. An unclassified layout extracts nothing. A proposer may suggest rows, and those rows still have to pass the kernel checks before anything posts. Re-uploading the same bytes of a posted job returns that job (`content_hash`). A different file with the same canonical amounts does not post again (`canonical_hash`). A job that is not posted is resumed. Accounts, periods, journals, and the posted job status commit in one database transaction. A failure rolls that transaction back and leaves the job in `needs_review` with no reversal rows. Overlapping comparative periods are reconciled to the ledger. A doubled balance sheet is a blocking exception. A mapping that changes statement class or sign stays below the 0.95 auto-accept line.

Amount scale includes units, thousands (`'000`), millions, lakhs, and crores, and is applied before minor units. `S$` is SGD and `A$` is AUD. `FY2024-25` without a document date or an organisation year end raises `confirm_period_end`. With either, the label uses that month and day for twelve months. An explicit 31 March date still runs 1 April through 31 March. `£m` and `$m` are millions. A header of N months ended is that span. Ordinal dates (`31st March`) and a from-to range of 3, 6, 9, or 12 months use that span. PDF bank columns align by x position. Print, run, and generated dates are not the period. Bank date order is inferred from the date column (a part greater than 12). Ambiguous dates raise `ambiguous_date`. Ledger balances used for posting are read inside the posting transaction under a row lock. A losing concurrent upload returns `FIN_IDEMPOTENCY_MISMATCH` instead of a database error.

When no error-severity exception is open, the service posts a linked model through the existing journal path. Repeating the post with the same input hash is a no-op.
