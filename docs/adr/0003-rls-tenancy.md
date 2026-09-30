# ADR 0003: Row-level security for tenancy

- Status: Accepted
- Date: 2026-09-30

## Context

Growing companies share one database. A missing `WHERE tenant_id` clause would leak another tenant's books. Authorization also has to fail closed when the caller is unknown.

## Decision

Every business table is scoped by `tenant_id`. Postgres row-level security is forced. The API connects as `nexora_app` (`NOBYPASSRLS`, not a superuser) and sets the tenant with `SET LOCAL`. Tenant, role, and region come from the authenticated actor. A body or query id is not sufficient. Production refuses to boot as the schema owner or without `DATABASE_URL`.

## Consequences

Migrations must keep forced row-level security and must not grant the API role a bypass. Support access is a time-boxed membership, not an impersonation path around RLS. Schema and policy changes are risk class R3.
