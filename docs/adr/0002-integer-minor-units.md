# ADR 0002: Integer minor units

- Status: Accepted
- Date: 2026-09-30

## Context

IEEE-754 binary floats cannot represent decimal currency. A hash of a float amount changes across languages, and a statement can fail to balance by a fraction of a cent.

## Decision

Ledger amounts are integer minor units (`numeric(38,0)` in Postgres, decimal strings in the kernel). Analytical work such as DCF uses `decimal.js` at precision 40 and serializes at 12 decimal places. Material hashes reject IEEE-754 numbers. Display formatting divides minor units for pixels and labels only; it does not create a new total.

## Consequences

APIs speak minor-unit strings. The UI formats them. A pull request that stores money as a JavaScript `number` in a material path is rejected.
