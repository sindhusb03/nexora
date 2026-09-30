# ADR 0004: Next.js for the web app

- Status: Accepted
- Date: 2026-09-30

## Context

The studio needs a server-rendered shell, a client command palette, charts, and a copilot drawer. The financial engine must stay on the server.

## Decision

`apps/web` is Next.js 15 with TypeScript, Tailwind, and shadcn/ui. TanStack Table, ECharts, and cmdk cover the grid, charts, and command palette. The app calls the Hono API. It does not calculate books or forecasts.

## Consequences

Presentation changes are risk class R1. They can ship without a kernel change only when every material number on screen is a kernel result. Playwright covers the studio flows.
