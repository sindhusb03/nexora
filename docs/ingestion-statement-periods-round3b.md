# Statement period round 3B

R3: statement periods affect financial observations. The kernel and posting rules are unchanged. Round 3A bank changes remain intact.

The resolver uses explicit ranges, localized statement phrases, column dates, or the organization fiscal-year setting. It does not derive fiscal year ends from country or currency. It scopes title evidence to each table, resolves comparative columns independently, and excludes run/print timestamps. Explicit interim columns and unresolved/conflicting dates produce confirm_period_end exceptions.

The synthetic corpus is generated reproducibly by apps/api/test/fixtures/statement-period-corpus.ts using the existing XLSX/CSV/text-PDF encoders. It contains no grading data. Tests assert exact values and ends per column, annual spans, open trap exceptions, persisted minor units, and no journals from incomplete/trapped uploads. The org-setting case is tested directly at the parser boundary; all other cases also pass through HTTP upload and persistence.

## Accuracy

Cells counts all printed amount cells; held counts cells intentionally withheld for period confirmation. Wrong counts emitted cells whose label, value, or end differs from independently authored truth.

| Fixture                      | Format |   Cells | Wrong |   Held |
| ---------------------------- | ------ | ------: | ----: | -----: |
| long-range                   | xlsx   |       2 |     0 |      0 |
| month-range                  | csv    |       2 |     0 |      0 |
| numeric-dmy                  | pdf    |       2 |     0 |      0 |
| numeric-mdy                  | xlsx   |       2 |     0 |      0 |
| en-dash                      | csv    |       2 |     0 |      0 |
| hyphen-month                 | pdf    |       2 |     0 |      0 |
| german-range                 | xlsx   |       2 |     0 |      0 |
| french-range                 | csv    |       2 |     0 |      0 |
| spanish-range                | xlsx   |       2 |     0 |      0 |
| japanese-range               | csv    |       2 |     0 |      0 |
| german-ended                 | xlsx   |       4 |     0 |      0 |
| french-ended                 | csv    |       2 |     0 |      0 |
| spanish-ended                | xlsx   |       2 |     0 |      0 |
| japanese-ended               | csv    |       2 |     0 |      0 |
| as-at-title                  | pdf    |       2 |     0 |      0 |
| as-of-columns                | pdf    |       4 |     0 |      0 |
| fy-four-digit                | csv    |       4 |     0 |      0 |
| fy-short-range               | pdf    |       4 |     0 |      0 |
| prior-0                      | xlsx   |       4 |     0 |      0 |
| prior-1                      | xlsx   |       4 |     0 |      0 |
| prior-2                      | xlsx   |       4 |     0 |      0 |
| prior-3                      | xlsx   |       4 |     0 |      0 |
| bare-fy                      | csv    |       6 |     0 |      6 |
| org-fy                       | pdf    |       4 |     0 |      0 |
| mixed-interim                | xlsx   |       8 |     0 |      6 |
| quarter                      | csv    |       2 |     0 |      2 |
| run-footer                   | pdf    |       2 |     0 |      0 |
| printed-only                 | xlsx   |       2 |     0 |      2 |
| run-only                     | csv    |       2 |     0 |      2 |
| basis-only                   | pdf    |       2 |     0 |      2 |
| conflict-title-column        | xlsx   |       2 |     0 |      2 |
| conflict-year                | csv    |       2 |     0 |      2 |
| ambiguous-range              | pdf    |       2 |     0 |      2 |
| undated-comparison           | xlsx   |       4 |     0 |      2 |
| range-column                 | pdf    |       2 |     0 |      0 |
| label-cell-fy                | xlsx   |       4 |     0 |      0 |
| prior-dated                  | csv    |       4 |     0 |      0 |
| dmy-column-evidence          | xlsx   |       4 |     0 |      0 |
| mdy-column-evidence          | csv    |       4 |     0 |      0 |
| ambiguous-column             | xlsx   |       2 |     0 |      2 |
| conflicting-date-order       | xlsx   |       6 |     0 |      6 |
| french-as-at                 | csv    |       2 |     0 |      0 |
| spanish-as-at                | xlsx   |       2 |     0 |      0 |
| japanese-as-at               | csv    |       2 |     0 |      0 |
| title-with-dated-comparative | xlsx   |       4 |     0 |      0 |
| stacked-spans                | xlsx   |       4 |     0 |      2 |
| offset-title-conflict        | xlsx   |       2 |     0 |      2 |
| offset-title-period          | xlsx   |       2 |     0 |      0 |
| shared-yearless-header       | xlsx   |       4 |     0 |      0 |
| **Total**                    |        | **146** | **0** | **40** |

106 extracted cells match exactly; 40 cells are intentionally held. No wrong extracted values or periods and no wrong automatic posts in these synthetic fixtures. This is synthetic regression evidence, not a claim about unseen grading data.
