# Ingestion round 1 repair

Baseline: `0ede160`, PR #5, Windows worktree. All edits remain uncommitted. No dependencies, migrations, kernel calculations, auth thresholds, or timeouts changed. The pre-existing `AGENTS.md` modification was left alone.

## Generated regression accuracy

These are new development fixtures, not the judge's files or a fresh blind grade. HTTP tests use a fresh tenant per document, no fiscal-year setting, and the deterministic proposer. The partial documents must not post journals.

| Family                                                     | Correct cells | Wrong values | Wrong auto-posts |
| ---------------------------------------------------------- | ------------: | -----------: | ---------------: |
| Number conventions, scale, native XLSX versus printed text |           9/9 |            0 |                0 |
| Indian bank CSV/PDF column roles                           |         12/12 |            0 |                0 |
| Bank fees, posting dates, narration currency               |         12/12 |            0 |                0 |
| Bank XLSX dates and amount suffixes                        |           8/8 |            0 |                0 |
| Bank currency columns                                      |           6/6 |            0 |                0 |
| Statement date ranges and Total columns                    |           6/6 |            0 |                0 |
| Japanese bilingual comparative statements                  |           4/4 |            0 |                0 |
| Merged XLSX headers and labels                             |           2/2 |            0 |                0 |
| Shared currency symbols with entity context                |           3/3 |            0 |                0 |
| **Total**                                                  |     **62/62** |        **0** |            **0** |

Six additional ambiguous/conflicting documents produce review holds and no extracted values or journals. The existing 528-cell adversarial corpus also passed with zero wrong values and wrong auto-posts.

## Tests

- `blind FAIL round 1 regression families`: generated documents, shared symbols, missing/invalid completed dates, ambiguous fees, split PDF headers, right alignment, repeated headers, and locale separators.
- `HTTP round 1: $id (fresh tenant, no FY setting)`: 31 documents through authenticated uploads, stored minor units/currencies/periods, and ledger reads.
- `reads committed ledger state inside the locked callback and isolates tenant and entity`: queued writer followed by a locked snapshot, including journals, lines, periods, accounts, and retained earnings; separate tenant remains empty.
- Existing rollback, idempotency, comparative snapshot, FY mismatch, qualifier, and period-trap checks remain enabled.

## Gates

| Command                                      | Latest result                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm lint`                                  | Pass                                                                                  |
| `pnpm typecheck`                             | Pass, 5 packages                                                                      |
| `pnpm build`                                 | Pass, unchanged web build reused from Turbo cache                                     |
| `pnpm exec prettier --check <changed files>` | Pass, all 21 changed or added files                                                   |
| `pnpm --filter @nexora/api test:accuracy`    | Pass, 108 tests                                                                       |
| `pnpm test` with `TURBO_FORCE=true`          | Fails only the existing auth concurrency assertion; 339 pass, 1 fail, 1 existing skip |
| Two consecutive green root runs              | Not yet achieved                                                                      |

Kernel line coverage: **90.92%**. Test shells unset `OPENAI_API_KEY` and `AI_API_KEY`.

The first root attempt reproduced the workspace timeout and both auth timing failures. Removing duplicate PGlite creation, sharing the ingestion HTTP app across isolated tenants, moving large corpora into `test:accuracy`, and sequencing default application/ingestion/auth groups fixed the workspace timeout and median test. Workspace completed in about 11 seconds against its unchanged 30-second limit.

The remaining `auth-factors.test.ts:890` assertion also fails with every ingestion test excluded: 596 ms running the auth file alone, 650 ms with the thread pool, and 764 ms running only the concurrency test; its limit is 500 ms. Auth implementation and tests are unchanged. An extension into auth transaction performance requires scope clarification before further changes.

## Files changed

| File                                       | Purpose                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/imports/decimal-text.ts`     | Infer a document number convention and reject ambiguous/conflicting punctuation.                                          |
| `apps/api/src/imports/currency.ts`         | Rank currency evidence and exclude bank narration from account metadata.                                                  |
| `apps/api/src/imports/bank-tabular.ts`     | Posting dates, fees, currency columns, bank roles, opening balances, PDF alignment, and review holds.                     |
| `apps/api/src/imports/document-parser.ts`  | Apply document evidence, preserve native numeric cells, carry entity context and bank Excel dates, resolve ranges/scales. |
| `apps/api/src/imports/period.ts`           | Resolve numeric and ISO date ranges without assuming ambiguous day/month order.                                           |
| `apps/api/src/imports/statement-xlsx.ts`   | Match merged period headers to amount columns and preserve accounting debit/credit semantics.                             |
| `apps/api/src/imports/statement-html.ts`   | Preserve printed punctuation until document convention inference.                                                         |
| `apps/api/src/imports/xlsx.ts`             | Retain merged-cell ranges.                                                                                                |
| `apps/api/src/ingestion/service.ts`        | Supply functional currency to parsers.                                                                                    |
| `apps/api/test/fixtures/round1-corpus.ts`  | Generate independent fixtures and expected facts.                                                                         |
| `apps/api/test/round1-regressions.test.ts` | Fast parser and safety regressions.                                                                                       |
| `apps/api/test/round1-accuracy.test.ts`    | Fresh-tenant HTTP accuracy and no-post assertions.                                                                        |
| `apps/api/test/harness.ts`                 | Avoid creating a discarded PGlite instance when a store is supplied.                                                      |
| `apps/api/test/ingestion.http.test.ts`     | Reuse one app while retaining separate tenant/entity scopes.                                                              |
| `apps/api/test/heldout-extraction.test.ts` | Supply the fixture's known functional currency; bare `$` alone is insufficient.                                           |
| `apps/api/test/layout.test.ts`             | Expect preserved HTML decimal text with unchanged financial value.                                                        |
| `apps/api/vitest.config.ts`                | Sequence application, ingestion, and auth tests; bound worker contention.                                                 |
| `apps/api/vitest.accuracy.config.ts`       | Run heavy generated corpora separately and sequentially.                                                                  |
| `apps/api/package.json`                    | Add `test:accuracy`.                                                                                                      |
| `packages/db/test/ingestion-post.test.ts`  | Add the locked-ledger snapshot regression.                                                                                |
| `docs/ingestion-accuracy.md`               | Record changes, accuracy, gates, and limitations.                                                                         |

## Review holds retained by design

- Three-digit separators without decisive locale/grouping evidence; mixed conventions or scales.
- Contradictory currency metadata, currency columns, or unambiguous symbols. An explicit foreign-currency source keeps its denomination and the kernel blocks posting into a different functional currency.
- Missing/ambiguous posting dates, negative/unclear fees, and fees alongside explicitly net amounts.
- Merged period headers spanning multiple populated amount columns.
- Existing interim/YTD/FY ambiguity, qualifier mappings, balance mismatches, and incomplete ledger packages.
