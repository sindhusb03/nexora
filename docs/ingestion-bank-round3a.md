# Bank extraction round 3A

Risk: R3. Base: `d81ba47`. Changes remain uncommitted.

The synthetic generator `apps/api/test/fixtures/bank-round3a-corpus.ts` defines
independent literal expected values and generates CSV, OOXML XLSX, and text-layer
PDF bytes on every run. No institution names, judge samples, external files, or
live AI are used. PDF fixtures include two pages, repeated headers, and a
continuation line. No dependencies were added.

The parser resolves account currency before selecting monetary columns, excludes
explicit original/foreign denominations, and checks redundant debit/credit versus
signed amounts. Summary rows are classified before number/date inference and
checked against transaction totals/counts. Dates must admit one interpretation
across the entire column, including boundary balances; missing years require an
explicit period. Reverse chronology, running balances, opening/closing balances,
and contradictory direction/currency evidence are checked with Decimal arithmetic.
Changed repeated headers require review. Descriptions containing summary words
remain transactions. Parser issues persist as open exceptions through ingestion.

## Synthetic accuracy

A cell is one opening/closing balance or transaction amount, matched with its
label, exact Decimal value, transaction date, direction, and currency. `Held` is
the number of documents with **parser** review exceptions. For traps, expected
cells contain only unambiguous values safe to retain for review; zero does not
mean the source had no numbers. This is a development corpus, not a blind score.

| Fixture                        | Format           | Correct / expected cells | Wrong |   Held |
| ------------------------------ | ---------------- | -----------------------: | ----: | -----: |
| local-settlement               | CSV              |                      4/4 |     0 |      0 |
| paired-with-fx                 | XLSX             |                      4/4 |     0 |      0 |
| hyphen-month-first             | CSV              |                      4/4 |     0 |      0 |
| year-boundary                  | PDF              |                      4/4 |     0 |      0 |
| named-day                      | XLSX             |                      4/4 |     0 |      0 |
| locale-direction               | CSV              |                      4/4 |     0 |      0 |
| integer-yen                    | XLSX             |                      4/4 |     0 |      0 |
| currency-date-cue              | CSV              |                      4/4 |     0 |      0 |
| explicit-denominations         | CSV              |                      3/3 |     0 |      0 |
| monotonic-evidence             | CSV              |                      5/5 |     0 |      0 |
| reverse-chronology             | XLSX             |                      4/4 |     0 |      0 |
| summary-words-in-narration     | CSV              |                      4/4 |     0 |      0 |
| boundary-date-evidence         | CSV              |                      3/3 |     0 |      0 |
| marked-pair                    | XLSX             |                      3/3 |     0 |      0 |
| metadata-fx                    | CSV              |                      3/3 |     0 |      0 |
| trap-date-order                | CSV              |                      0/0 |     0 |      1 |
| trap-running-balance           | XLSX             |                      3/3 |     0 |      1 |
| trap-footer-total              | PDF              |                      3/3 |     0 |      1 |
| trap-missing-year              | CSV              |                      0/0 |     0 |      1 |
| trap-count                     | CSV              |                      3/3 |     0 |      1 |
| trap-duplicate-role            | XLSX             |                      0/0 |     0 |      1 |
| trap-redundant-disagreement    | CSV              |                      1/1 |     0 |      1 |
| trap-conflicting-date-evidence | CSV              |                      0/0 |     0 |      1 |
| trap-suffix-conflict           | CSV              |                      1/1 |     0 |      1 |
| trap-foreign-only              | CSV              |                      0/0 |     0 |      1 |
| trap-header-denomination       | CSV              |                      0/0 |     0 |      1 |
| trap-narrative-currency        | PDF              |                      0/0 |     0 |      1 |
| trap-row-denomination          | CSV              |                      0/0 |     0 |      1 |
| trap-swapped-header            | PDF              |                      0/0 |     0 |      1 |
| trap-balance-sign              | CSV              |                      0/0 |     0 |      1 |
| trap-token-currency            | CSV              |                      0/0 |     0 |      1 |
| trap-compact-marker            | CSV              |                      1/1 |     0 |      1 |
| **Total**                      | **32 documents** |                **69/69** | **0** | **17** |

The 15 valid layouts recover 57/57 cells. The 17 traps retain 12 independently
readable cells while holding their documents. All 32 HTTP uploads assert exact
persisted minor units/currency and an empty journal list: zero auto-posts. Even
valid bank-only documents remain `needs_review` in the API because they do not
supply the other statements needed for a complete ledger package.

## Tests and review

`bank-round3a.test.ts` adds 64 parameterized tests:

- `exact amount/date/direction/currency or review: $id` (32 parser goldens).
- `upload safety: $id` (32 real upload/persistence/exception/posting checks).

New failure cases were run red before their fixes. An independent read-only
review identified four additional currency/header/sign gaps, each reproduced in
a new trap before fixing it. This agent review is not a substitute for the two
human approvals required by the repository's R3 process.

Financial review: money stays in Decimal or integer minor-unit strings; no kernel
posting, schema, tenant isolation, auth, CI, or journal immutability behavior was
changed. Existing exception handling prevents posting unresolved documents.
Rollback consists of reverting this parser change; it requires no migration and
does not rewrite posted journals.

Unresolved layouts, conflicting evidence, missing years without a period, and
unreconciled statements deliberately remain review-held. No claim is made about
accuracy on future blind data.

## Final gates

| Command                                                   | Result                                           |
| --------------------------------------------------------- | ------------------------------------------------ |
| `pnpm lint`                                               | Pass                                             |
| `pnpm typecheck`                                          | Pass, 5 packages                                 |
| `pnpm test --force` — final run 1                         | Pass, 522 tests; 1 existing skip; 0 cached tasks |
| `pnpm test --force` — final run 2                         | Pass, 522 tests; 1 existing skip; 0 cached tasks |
| `pnpm build`                                              | Pass, existing web build cache hit               |
| `pnpm exec prettier --check` on all 7 changed/added files | Pass                                             |
| `git diff --check`                                        | Pass                                             |

Kernel line coverage: 90.92% on both final uncached runs. The initial full run
found an existing expected `balance_mismatch` exception missing on an ambiguous-date
statement without an opening balance; that compatibility regression was fixed
before both final runs. All tests ran with `OPENAI_API_KEY` and `AI_API_KEY`
unset. Windows `Path`/`PATH` casing was normalized in the shell environment only
so pnpm could find local executables; no package scripts/configuration changed.
