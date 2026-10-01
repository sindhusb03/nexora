---
"@nexora/api": patch
"@nexora/web": patch
---

Parse CSV amounts exactly and flag ambiguous inputs for review. Authorize file imports and reuse stored results before parsing. Display currency minor units correctly, neutralize spreadsheet formulas in exports, and clear uploaded data when identity changes. Make magic-link timing regressions deterministic and require explicit production boot-refusal evidence in CI.
