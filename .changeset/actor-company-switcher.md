---
"@nexora/db": patch
"@nexora/kernel": patch
"@nexora/api": patch
"@nexora/web": patch
---

List the signed-in actor's active companies from membership. A self-service first run, when the owner has no active membership, replays a concurrent open of the same name in the same region and returns that company. A different region is rejected. A later company with the same name, and a platform-admin provision, each insert a new company.
