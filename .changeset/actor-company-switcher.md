---
"@nexora/db": patch
"@nexora/api": patch
"@nexora/web": patch
---

List the signed-in actor's active companies from membership. A self-service first run, when the owner has no active membership, replays a concurrent open of the same name and returns that company. A later company with the same name, and a platform-admin provision, each insert a new company.
