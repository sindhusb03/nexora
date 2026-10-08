# @nexora/kernel

## 0.1.2

### Patch Changes

- 88791b8: Derive financial states from kernel statements with calculation lineage, serialize publication atomically, and validate tenant-scoped program parents. Lock period writes and posting, allow historical statements after later activity, attribute actual cash by journal, and correct opening retained earnings for prior distributions. Bump the calculation engine to fe-kernel-0.2.1 and display server-computed income in the program UI.

## 0.1.1

### Patch Changes

- 6a23642: Read localized financial statement layouts with exact multilingual labels, stacked period headers, explicit units and document-wide number evidence. Keep unknown labels and ambiguous layouts in review.
- 32ec0c5: Extract independently titled statement blocks and semantic net columns across tabular and text-PDF uploads. Reconcile gross/depreciation/net and T-format side and group totals exactly in the Decimal kernel, exclude transfers from account lines, and hold ambiguous layouts for review.
