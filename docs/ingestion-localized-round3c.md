# Round 3C: localized statements

Risk: R3. Builds on the uncommitted bank and period rounds at HEAD d81ba47.
No posting, auth, schema, dependency or CI changes.

Complete FR/DE/ES/JA label synonyms map in the kernel. Unknown and qualified
localized labels remain unmapped; no fuzzy translation is auto-accepted. Localized
net income and balance totals retain their total role. Unsupported loss-label
sign semantics and unspecified debt maturities remain for review.

The tabular/PDF readers share statement-title, annotation-column and scale phrase
tables. Stacked headers retain their source column; notes, codes, gross and
accumulated columns are excluded. Japanese Gregorian dates and explicit fiscal
month ends (including Reiwa) are supported. Period rules from 3B still apply.
Numeric spreadsheet cells keep their decimal representation; text amounts require
consistent document-wide evidence. Ambiguous separators, mixed conventions and
unsupported explicit scales hold the document. Scaling occurs once, in the
existing Decimal-to-minor-unit path.

Synthetic fixtures are authored in `apps/api/test/fixtures/localized-corpus.ts`;
xlsx/csv bytes are generated during tests. Three real PDF fixtures embed the
Unicode Vera TrueType font. Regenerate them using
`python apps/api/test/fixtures/generate-localized-pdfs.py` (reportlab is only a
generation tool; tests consume the checked-in PDFs). Expected values are literal
author-specified amounts, independent of the parser and production dictionaries.

| Fixture                  |  Cells | Wrong |   Held |
| ------------------------ | -----: | ----: | -----: |
| fr-sa-income (xlsx)      |      3 |     0 |      0 |
| fr-sa-income-pdf         |      3 |     0 |      0 |
| fr-sa-balance (csv)      |      3 |     0 |      0 |
| de-gmbh-income (csv)     |      3 |     0 |      0 |
| de-gmbh-income-pdf       |      3 |     0 |      0 |
| de-gmbh-balance (xlsx)   |      3 |     0 |      0 |
| es-sl-income (xlsx)      |      3 |     0 |      0 |
| es-sl-income-pdf         |      3 |     0 |      0 |
| es-sl-balance (csv)      |      3 |     0 |      0 |
| ja-kk-income (xlsx)      |      3 |     0 |      0 |
| ja-kk-balance (xlsx)     |      3 |     0 |      0 |
| in-lakhs-income (csv)    |      3 |     0 |      0 |
| in-crores-balance (xlsx) |      3 |     0 |      0 |
| mixed-conventions        |      2 |     0 |      2 |
| ambiguous-separator      |      2 |     0 |      2 |
| unknown-scale            |      2 |     0 |      2 |
| conflicting-scale        |      2 |     0 |      2 |
| unknown-labels           |      3 |     0 |      3 |
| **Total**                | **50** | **0** | **11** |

Held counts measure extraction/mapping review, not permission to post an incomplete
statement. Upload tests verify persisted scaled amounts and dates, open exceptions
for unknown labels and ambiguous documents, and no journals for these incomplete
fixtures. Additional regression cases cover Japanese headers, currency evidence,
dated non-period columns and mixed conventions across sheets. These are synthetic
goldens, not a claim about held-out accuracy.

Rollback: revert only the round 3C parsing/dictionary changes; reprocess unposted
imports after restoring the prior parser. Never rewrite posted journals.

- [x] I completed the financial review checklist in docs/review-workflow.md
