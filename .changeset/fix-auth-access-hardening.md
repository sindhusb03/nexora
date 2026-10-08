---
"@nexora/api": patch
---

Disable signup by default, reserve administrative identities, and require explicit acknowledgement when signup coexists with platform admins. Enforce support expiry before tenant access and session rotation, removing expired memberships with audit events. Check both IP limits before reading credential bodies, cap them at 16 KiB, and parse JSON once.
