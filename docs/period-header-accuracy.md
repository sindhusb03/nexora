# Round 4A synthetic period-header accuracy

Authored sources in `apps/api/test/fixtures/period-header-corpus.ts` generate CSV,
XLSX and text-layer PDF bytes using the existing deterministic writers. Expected
periods and Decimal values are independent literals. The golden test compares
labels, Decimal values, period starts and ends; the upload test checks persisted
minor units, open exceptions and an empty journal list for every fixture.

These are synthetic development fixtures, not a blind-grade result. Held cells
are intentional safety refusals. Accuracy on the 62 resolvable cells is 100%;
all 24 unsafe cells are held, with zero wrong extracted cells and zero auto-posts.

| Fixture                    | Language | Format |  Cells | Wrong |   Held |
| -------------------------- | -------- | ------ | -----: | ----: | -----: |
| en-shared-year             | EN       | CSV    |      2 |     0 |      2 |
| en-full-months             | EN       | XLSX   |      2 |     0 |      0 |
| en-short-months            | EN       | PDF    |      2 |     0 |      0 |
| en-two-years               | EN       | CSV    |      2 |     0 |      0 |
| en-to                      | EN       | XLSX   |      2 |     0 |      0 |
| en-through                 | EN       | PDF    |      2 |     0 |      0 |
| de-shared-day-year         | DE       | XLSX   |      2 |     0 |      0 |
| de-numeric                 | DE       | CSV    |      2 |     0 |      0 |
| de-fiscal                  | DE       | XLSX   |      4 |     0 |      0 |
| fr-range                   | FR       | CSV    |      2 |     0 |      0 |
| fr-fiscal                  | FR       | XLSX   |      4 |     0 |      0 |
| fr-ended                   | FR       | CSV    |      2 |     0 |      0 |
| es-range                   | ES       | XLSX   |      2 |     0 |      0 |
| es-fiscal                  | ES       | PDF    |      4 |     0 |      0 |
| es-ended                   | ES       | CSV    |      2 |     0 |      0 |
| it-fiscal                  | IT       | PDF    |      4 |     0 |      0 |
| pt-fiscal                  | PT       | XLSX   |      2 |     0 |      0 |
| nl-fiscal                  | NL       | PDF    |      2 |     0 |      0 |
| ja-range                   | JA       | CSV    |      2 |     0 |      0 |
| ja-fiscal                  | JA       | XLSX   |      4 |     0 |      0 |
| ja-from-to                 | JA       | XLSX   |      2 |     0 |      0 |
| bare-fiscal-trap           | ES       | CSV    |      2 |     0 |      2 |
| conflicting-range-trap     | EN       | XLSX   |      2 |     0 |      2 |
| printed-trap               | FR       | CSV    |      2 |     0 |      2 |
| n-comparative              | FR       | PDF    |      4 |     0 |      0 |
| bare-years                 | EN       | XLSX   |      4 |     0 |      0 |
| interim-trap               | EN       | CSV    |      4 |     0 |      4 |
| printed-as-of-trap         | EN       | PDF    |      2 |     0 |      2 |
| explicit-prior-start       | EN       | XLSX   |      2 |     0 |      0 |
| fiscal-end-line            | EN       | CSV    |      4 |     0 |      0 |
| conflicting-flow-calendars | EN       | XLSX   |      4 |     0 |      4 |
| short-range-trap           | FR       | CSV    |      2 |     0 |      2 |
| non-month-end-trap         | EN       | XLSX   |      2 |     0 |      2 |
| ambiguous-year-title-trap  | EN       | PDF    |      2 |     0 |      2 |
| **Total**                  |          |        | **86** | **0** | **24** |

Additional safeguards cover missing and printed-only evidence for each fiscal
label, organisation year-end settings, interim ranges and contradictory fiscal
year-end declarations. Existing round 3B goldens retain explicit ranges,
Selected Period/Total, FY comparisons, print/run footer exclusions and date-order
ambiguity checks. No kernel formulas, monetary conversions or dependencies change.
