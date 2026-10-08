---
"@nexora/kernel": patch
"@nexora/db": patch
"@nexora/api": patch
"@nexora/web": patch
---

Derive financial states from kernel statements with calculation lineage, serialize publication atomically, and validate tenant-scoped program parents. Lock period writes and posting, allow historical statements after later activity, attribute actual cash by journal, and correct opening retained earnings for prior distributions. Bump the calculation engine to fe-kernel-0.2.1 and display server-computed income in the program UI.
