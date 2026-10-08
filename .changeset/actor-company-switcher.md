---
"@nexora/db": patch
"@nexora/api": patch
"@nexora/web": patch
---

List the signed-in actor's active companies from membership. A first-run retry reuses a company only when that actor already owns the same name, and opening that name again returns the existing company.
