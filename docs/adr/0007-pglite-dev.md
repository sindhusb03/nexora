# ADR 0007: PGlite for local development

- Status: Accepted
- Date: 2026-09-30

## Context

Contributors and CI need the schema, triggers, and row-level security without a hosted database or customer data. Production still runs on Postgres.

## Decision

With no `DATABASE_URL`, outside production, the API uses embedded PGlite, applies migrations itself, and seeds the Nazareno Services LLC demo when `NEXORA_SEED_DEMO` is not `false`. CI database tests use that same embedded database. A separate CI job boots against Postgres 17 as `nexora_app` and checks production fail-closed paths.

`pgvector` is not created in the shared migration. Stock Postgres 17 has no extension. Retrieval stays an in-process hybrid until an image provides the extension.

## Consequences

Demo workbooks and secrets stay out of git. Production migrations are applied by the owner role before the API starts. PGlite is not the production database.
