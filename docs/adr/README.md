# Architecture decision records

Accepted decisions. A new decision gets the next number. Do not edit an accepted ADR in place; supersede it.

| ADR                                     | Decision                                                   |
| --------------------------------------- | ---------------------------------------------------------- |
| [0001](0001-kernel-source-of-truth.md)  | The Financial Kernel is the only source of financial truth |
| [0002](0002-integer-minor-units.md)     | Ledger amounts are integer minor units                     |
| [0003](0003-rls-tenancy.md)             | Tenants are isolated with Postgres row-level security      |
| [0004](0004-nextjs-web.md)              | The product UI is a Next.js app                            |
| [0005](0005-ai-proposes-never-posts.md) | AI proposes and explains; it never posts                   |
| [0006](0006-mock-mode-ai.md)            | The copilot runs in mock mode without an API key           |
| [0007](0007-pglite-dev.md)              | Local development uses embedded PGlite                     |
