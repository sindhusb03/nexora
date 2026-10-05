# ADR 0008: Numeric policy and calculation registry

- Status: Accepted
- Date: 2026-10-05

## Context

Nexora extends statements into capital markets and valuation. These surfaces need a shared numeric policy and a discoverable catalog of approved calculations without creating another source of financial truth.

## Decision

Ledger truth remains integer minor units through the existing `Money` type: serialized integer strings, with `bigint` arithmetic. Analytical math uses the existing `AnalyticalDecimal` / `decimal.js` policy (precision 40, half-even rounding), with decimal strings at API boundaries. JavaScript `number` and binary floating point (`f64`) must never represent financial truth. Numbers may describe nonfinancial metadata such as currency scale; they must not become material amounts, rates, or totals.

`CalcRegistry` in `@nexora/kernel` catalogs approved calculation surfaces by unique id, domain, helper name, input/output shape, and version. Phase 0 registers the existing `addMoney`, `subtractMoney`, and `negateMoney` helpers. The registry is metadata, not an execution engine or a claim that every kernel helper has been cataloged. Duplicate ids are rejected; a registry instance holds one approved version per id.

This extends [ADR 0001: Kernel source of truth](0001-kernel-source-of-truth.md) and [ADR 0002: Integer minor units](0002-integer-minor-units.md). Their rules for server computation, lineage, analytical serialization, and material hashes still apply.

## Consequences

New calculation surfaces should add versioned registry entries alongside kernel tests. Ledger helpers retain their currency and scale checks. Analytical results convert to ledger amounts only at an explicit boundary with currency scale and rounding policy; display formatting never creates financial truth. No new money library or client-side financial computation is introduced.
