# ADR 0001: The kernel is the source of truth

- Status: Accepted
- Date: 2026-09-30

## Context

Nexora shows statements, forecasts, cash, variance, and quality of earnings to operators and boards. A model, a spreadsheet, or the browser can each invent a second total. Posted books then disagree with the screen, and lineage cannot be reconstructed.

## Decision

`@nexora/kernel` is the only component that computes financial truth. The database stores journals and constraints. The API calls the kernel and returns those results. The web app displays server strings. It does not import `@nexora/kernel`. A client-supplied total is never stored as the book or the forecast.

Every material calculated output carries lineage: engine version and a hash of its inputs.

## Consequences

Formula changes start in the kernel, with golden tests, and ship in kernel order: domain, persistence, API, UI. A pull request that computes a material number in the client is rejected.
