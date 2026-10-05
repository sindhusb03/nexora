# Round 4B: synthetic bank layout accuracy

R3: bank money extraction, date attribution and financial review safety. No kernel, ledger, database or auth changes. Round 4A remains intact.

The corpus is authored independently in `apps/api/test/fixtures/bank-layout-corpus.ts`. It generates real CSV, OOXML and text-layer PDF bytes on each run. Literal goldens assert Decimal amounts, dates, direction, currency and opening/closing classification. HTTP goldens assert exact stored minor units, open trap exceptions and zero posted journals. No institution names or fixture identifiers drive parsing.

| Fixture                   | Format         |      Exact cells | Wrong cells | Expected review exception |
| ------------------------- | -------------- | ---------------: | ----------: | ------------------------- |
| german                    | CSV            |              4/4 |           0 | —                         |
| french                    | XLSX           |              4/4 |           0 | —                         |
| spanish                   | CSV            |              4/4 |           0 | —                         |
| portuguese                | XLSX           |              4/4 |           0 | —                         |
| italian                   | CSV            |              4/4 |           0 | —                         |
| dutch                     | XLSX           |              4/4 |           0 | —                         |
| kanji                     | CSV            |              4/4 |           0 | —                         |
| fullwidth                 | CSV            |              4/4 |           0 | —                         |
| era-rule                  | CSV            |              4/4 |           0 | —                         |
| quoted-comma              | CSV            |              4/4 |           0 | —                         |
| quoted-semicolon          | CSV            |              4/4 |           0 | —                         |
| quoted-tab                | CSV            |              4/4 |           0 | —                         |
| headerless-balance        | CSV            |              4/4 |           0 | —                         |
| headerless-paired         | XLSX           |              4/4 |           0 | —                         |
| headerless-reordered      | CSV            |              4/4 |           0 | —                         |
| headerless-direction      | CSV            |              4/4 |           0 | —                         |
| headerless-broken         | CSV            |       0/0 (held) |           0 | layout_unresolved         |
| headerless-dateless-first | CSV            |       0/0 (held) |           0 | layout_unresolved         |
| unsigned-no-balance       | CSV            |       0/0 (held) |           0 | layout_unresolved         |
| grouped-date              | XLSX           |              4/4 |           0 | —                         |
| dateless-first            | CSV            |       0/0 (held) |           0 | ambiguous_date            |
| carry-balance-mismatch    | CSV            |       0/0 (held) |           0 | balance_mismatch          |
| ragged-row                | CSV            |       0/0 (held) |           0 | layout_unresolved         |
| era-without-rule          | CSV            |       0/0 (held) |           0 | ambiguous_date            |
| split-repeated-legend     | PDF            |              4/4 |           0 | —                         |
| page-date-reset           | PDF            |       0/0 (held) |           0 | ambiguous_date            |
| legend-numeric-table      | PDF            |              4/4 |           0 | —                         |
| pdf-grouped-date          | PDF            |              4/4 |           0 | —                         |
| declared-date-grouping    | CSV            |              4/4 |           0 | —                         |
| page-column-reanchor      | PDF            |              4/4 |           0 | —                         |
| unanchored-pdf-row        | PDF            |       0/0 (held) |           0 | layout_unresolved         |
| **Total**                 | **31 layouts** | **88/88 (100%)** |       **0** | **9/9 traps held**        |

This measures the authored synthetic set, not the next blind set. Numeric legends are intentionally ignored rather than treated as transactions or totals. Headerless direction requires a unique complete reconciliation or explicit direction cues. Grouped date carry requires running-balance evidence or an explicit source declaration, and resets at repeated headers/pages. Unresolved grouped layouts retain no values. Independently printed facts in existing ordinary-layout regressions remain available for review, without inferring closing balances from incomplete activity.

Four existing `bank-value-corpus.ts` rows now explicitly encode the empty trailing reference field, preserving their original golden facts and their direction/missing-date test purpose under strict CSV row-width validation.
