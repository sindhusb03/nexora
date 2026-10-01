# Ingestion contract

This is the contract the exception review UI calls. `feat/ingestion-core` implements the HTTP routes. This branch ships the schemas in `@nexora/contracts` and a typed client. The web app uses the mock client unless `NEXT_PUBLIC_INGESTION_MODE=http`.

The Financial Kernel is not on this path. Extracted amounts and resolutions are proposals. Nothing here posts a journal, publishes a statement, or treats a client total as books.

## Money and confidence

- `expected`, `actual`, `diff`, and `amountMinor` are integer minor-unit strings (`-?\d+`). USD uses cents. INR uses paise. Floats are rejected.
- `diff` is supplied by extraction. The client must not recompute it.
- `confidence` is the extractor's certainty that the extracted value or the check is right. It is a decimal string from `0` to `1` with at most four fraction digits, for example `0.9700`. It is not a probability that the books are correct, and it is not money.
- A correction stores the proposed minor-unit string on `resolution.after`. It does not replace `values.actual`.

## Resources

### Extraction job

| Field                    | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `id`                     | Server-generated job id                                           |
| `status`                 | `queued`, `extracting`, `checking`, `ready`, `failed`             |
| `createdAt`, `updatedAt` | UTC ISO-8601                                                      |
| `context`                | As-of date, basis label, and the unposted disclaimer              |
| `documents`              | Source files the extractor opened                                 |
| `uploads`                | Caller files and per-file progress                                |
| `chart`                  | Accounts the remap picker may propose. The chart is not a posting |
| `summary`                | Counts once `ready`, otherwise `null`                             |
| `error`                  | Failure payload when `status` is `failed`, otherwise `null`       |

### Source document

`id`, `jobId`, `fileName`, `mediaType` (`application/pdf`, `text/csv`, or xlsx), `pageCount`, `sheetNames`, `regionHint`, `currency`, `entityName`, `pdfBase64` (null for spreadsheets and csv).

### Extracted value

`id`, `jobId`, `documentId`, `label`, `statement` (`income`, `balance`, `cash`, `bank`, `tax`), `periodLabel`, `amountMinor`, `currency`, `provenance`, `sheetWindow`.

`sheetWindow` is source text around a spreadsheet cell, including `highlightRow` and `highlightCol`. It is display context, not a calculation.

### Provenance

`documentId`, `fileName`, `page`, `sheet`, `row`, `col`, `bbox`, `rawText`.

`bbox` is PDF user space in integer points: origin at the bottom left of the page, `x`, `y`, `width`, `height`. Row and column are 1-based spreadsheet coordinates. Unused locators are `null`.

### Exception

`id`, `jobId`, `documentId`, `valueIds`, `type`, `severity` (`error`, `warn`, `info`), `message`, `values` (`expected`, `actual`, `diff`, `currency`), `confidence`, `provenance`, `status`, `mappedAccount`, `resolution`, `auditTrail`.

`mappedAccount` is the chart code currently proposed for the value, or `null` when the source line is unmapped.

Check types:

| Type                        | What the reviewer is deciding                      |
| --------------------------- | -------------------------------------------------- |
| `balance_sheet_equation`    | Assets versus liabilities and equity               |
| `cash_rollforward`          | Opening cash plus movement versus ending cash      |
| `retained_earnings_tie`     | Net income versus the retained earnings movement   |
| `unmapped_account`          | Source label with no chart account                 |
| `sign_convention`           | Debit or credit looks reversed                     |
| `duplicate_extraction`      | The same source amount was read twice              |
| `low_confidence_extraction` | The extractor is below the review threshold        |
| `currency_mismatch`         | Amount currency differs from the document currency |
| `unit_scale`                | Units, thousands, or lakhs look wrong              |
| `missing_period`            | No period was found                                |
| `bank_to_book`              | Bank ending balance versus book cash               |
| `tax_tie`                   | GST or other tax line versus the statement         |
| `header_as_value`           | A header was read as a number                      |
| `formula_cached_mismatch`   | A spreadsheet formula differs from the cached cell |

`error` severity blocks "model ready". `warn` and `info` do not.

### Resolution

`action`, `by`, `at`, `note`, `before`, `after`.

`by` and `at` are server-assigned. The HTTP body must not be trusted for the actor. The mock records the actor id the signed-in UI passes in because it has no session of its own.

`before` / `after`:

| Action           | `before`                                          | `after`                    |
| ---------------- | ------------------------------------------------- | -------------------------- |
| `accept`         | extracted `actual`                                | extracted `actual`         |
| `correct`        | extracted `actual`                                | proposed minor-unit string |
| `remap`          | previous `mappedAccount`, or `null` when unmapped | proposed account code      |
| `not_applicable` | `null`                                            | `null`                     |

`auditTrail` appends each resolution. `resolution` is the latest entry.

## Endpoints

Tenant, role, and region come from the session. A body or query company id is not authorization. Another tenant's job returns `AUTH_SCOPE_DENIED`.

Resolve and bulk-accept require the session role `owner` or `controller`. A `viewer`, or a `platform-admin` who does not also hold one of those roles, receives `AUTH_SCOPE_DENIED` and the exception stays open. The review UI disables those actions for the same roles.

Cookie-authenticated writes send `x-csrf-token` from the session. A missing or invalid token returns `AUTH_CSRF_FAILED`. The client does not send the actor id.

Writes send `Idempotency-Key` and the same value as `idempotencyKey`. Replaying the same key and body returns the original result. The same key with a different body returns `INGESTION_IDEMPOTENCY_CONFLICT`.

| Method | Path                                   | Success                                           |
| ------ | -------------------------------------- | ------------------------------------------------- |
| `POST` | `/v1/ingestion/uploads`                | `201` extraction job, status `queued`             |
| `GET`  | `/v1/ingestion/jobs/:id`               | Extraction job                                    |
| `GET`  | `/v1/ingestion/jobs/:id/values`        | `{ "values": ExtractedValue[] }`                  |
| `GET`  | `/v1/ingestion/jobs/:id/exceptions`    | `{ "exceptions": Exception[] }`                   |
| `POST` | `/v1/ingestion/exceptions/:id/resolve` | Updated exception                                 |
| `POST` | `/v1/ingestion/exceptions/bulk-accept` | `{ "exceptions": Exception[] }` for the whole job |

`GET` values and exceptions return `409` `INGESTION_JOB_NOT_READY` until status is `ready`.

### Upload body

```json
{
  "files": [
    {
      "fileName": "Nazareno_Income_Statement_FY2025.xlsx",
      "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "byteLength": 128,
      "contentBase64": "..."
    }
  ],
  "idempotencyKey": "upload-8f0c0c4e"
}
```

Only `.xlsx`, `.csv`, and `.pdf`. The extension must match `mediaType`. `byteLength` must equal the decoded base64 size. Empty files return `INGESTION_EMPTY_UPLOAD`. Other types return `INGESTION_UNSUPPORTED_FILE`. At most 20 files, 25 MB each. The client sends `idempotencyKey` in the body and the same value as `Idempotency-Key`.

### Resolve body

```json
{
  "action": "correct",
  "note": "Tie assets to liabilities and equity",
  "correctedMinor": "12420000000",
  "accountCode": null,
  "idempotencyKey": "8f0c0c4e-1b2a-4d5e-9c3a-0a1b2c3d4e5f"
}
```

`correctedMinor` is required only for `correct`. `accountCode` is required only for `remap`. The other action must send both as `null`.

### Bulk accept body

```json
{
  "jobId": "job_1",
  "exceptionIds": ["job_1_sign_convention"],
  "note": "High-confidence warnings",
  "idempotencyKey": "bulk-8f0c0c4e"
}
```

The server checks every id. If any id is missing, already resolved, severity `error`, below confidence `0.9000`, or a check failure, the call returns `INGESTION_BULK_REJECTED` or `INGESTION_EXCEPTION_NOT_FOUND` and changes nothing.

Bulk accept is only for open advisory items at confidence `0.9000` or higher: `missing_period`, and `header_as_value` when expected, actual, and diff are all null. `low_confidence_extraction` is never bulk-accepted. A `header_as_value` row with a non-null expected, actual, or diff is not bulk-eligible. Accept on that row returns `HEADER_VALUE_NOT_ACCEPTABLE` (HTTP 422) and changes nothing. The reviewer chooses `not_applicable` or `correct`, and the audit trail records that action. Duplicate extraction, unit scale, sign convention, cash roll-forward, and tie-outs (balance sheet, retained earnings, tax, bank to book, formula cache, and currency mismatch) are never bulk-accepted. High confidence on those checks means the failure is real.

The response list is the full exception set after a successful accept, so the client can refresh counts without treating the request body as the new truth.

The bulk-accept confirmation lists every candidate's type, message, confidence, expected amount, actual amount, and diff. The reviewer sees the figures that will be accepted before confirming.

## Status transitions

Job: `queued` → `extracting` → `checking` → `ready`. `failed` is terminal.

Exception, from `open` only:

| Action           | Next status      |
| ---------------- | ---------------- |
| `accept`         | `accepted`       |
| `correct`        | `corrected`      |
| `remap`          | `remapped`       |
| `not_applicable` | `not_applicable` |

Any later resolve returns `INGESTION_INVALID_TRANSITION`. There is no reopen on this contract.

Those rows are the only status mapping. Accept of a `header_as_value` item with a non-null expected, actual, or diff returns `HEADER_VALUE_NOT_ACCEPTABLE` (HTTP 422). The exception stays `open` and the audit trail is unchanged until the reviewer chooses `not_applicable` or `correct`.

"Model ready" in the UI means `blockingOpen === 0` on a ready job, including a job with zero exceptions. `blockingOpen` counts exceptions that are still `open` with severity `error`. It does not mean the kernel has calculated or posted a model.

## Error shape

HTTP 4xx and 5xx use the API envelope. The client parses it with `apiErrorEnvelopeSchema` / `readApiError`. A body without `error.code` and `error.message` is reported as an unreadable error.

```json
{
  "error": {
    "code": "INGESTION_INVALID_TRANSITION",
    "message": "Exception job_1_balance_sheet_equation is accepted and cannot be resolved again."
  }
}
```

| Code                             | When                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `INGESTION_VALIDATION_FAILED`    | Zod rejection, bad minor units, inconsistent size                                     |
| `INGESTION_UNSUPPORTED_FILE`     | Extension or media type is not xlsx, csv, or pdf                                      |
| `INGESTION_EMPTY_UPLOAD`         | Zero-byte file                                                                        |
| `INGESTION_JOB_NOT_FOUND`        | Unknown job id                                                                        |
| `INGESTION_JOB_NOT_READY`        | Values or exceptions requested before `ready`                                         |
| `INGESTION_EXCEPTION_NOT_FOUND`  | Unknown exception id for the caller's tenant                                          |
| `INGESTION_INVALID_TRANSITION`   | Resolve of a non-open exception                                                       |
| `INGESTION_IDEMPOTENCY_CONFLICT` | Same key, different body                                                              |
| `INGESTION_BULK_REJECTED`        | Bulk set includes an error, a check failure, a low-confidence item, or a duplicate id |
| `HEADER_VALUE_NOT_ACCEPTABLE`    | HTTP 422. Accept of a `header_as_value` whose expected, actual, or diff is non-null   |
| `INGESTION_UNAVAILABLE`          | The client cannot reach the ingestion API                                             |
| `AUTH_SCOPE_DENIED`              | Job is outside the session tenant, or the role cannot resolve                         |
| `AUTH_CSRF_FAILED`               | Cookie write is missing or has an invalid `x-csrf-token`                              |

## Client switch

`apps/web/app/review/client.ts` is the only switch:

- unset or `mock`: in-memory fixture client (India and US examples, every check type)
- `http`: `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8787`) plus the `/v1` paths above, with the session cookie

The HTTP client sends the idempotency key and `x-csrf-token` on writes, and does not send an actor id. The mock client records the signed-in actor and rejects resolve and bulk-accept unless the role is `owner` or `controller`.
