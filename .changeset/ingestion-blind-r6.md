---
"@nexora/api": patch
---

Bank and statement ingestion (blind-r6): keep a printed closing balance only when it reconciles with opening plus transactions, or when the running balances are themselves inconsistent (which goes to review); drop a closing that contradicts reconciling running balances. Add signed single-amount columns, Dutch signed decimals, Swiss German preambles and headers, PDF B/F and C/F rows, counterparty-first descriptions, and localized Swiss German, Portuguese, Spanish and Korean statement titles and periods.
