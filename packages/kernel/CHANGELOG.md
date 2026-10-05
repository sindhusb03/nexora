# @nexora/kernel

## 0.1.1

### Patch Changes

- 6a23642: Read localized financial statement layouts with exact multilingual labels, stacked period headers, explicit units and document-wide number evidence. Keep unknown labels and ambiguous layouts in review.
- 32ec0c5: Extract independently titled statement blocks and semantic net columns across tabular and text-PDF uploads. Reconcile gross/depreciation/net and T-format side and group totals exactly in the Decimal kernel, exclude transfers from account lines, and hold ambiguous layouts for review.
