# ADR 0005: AI proposes and never posts

- Status: Accepted
- Date: 2026-09-30

## Context

Operators want a copilot that explains revenue, cash, and adjustments. A model that can insert a journal, or whose sentence is trusted as a figure, becomes a second source of truth.

## Decision

The copilot may explain kernel outputs and tenant documents. Tools run before the model speaks. `groundModelText` rejects any number in the model text that is not already in that corpus. Agents write proposals into the approvals inbox. A person accepts or rejects. Nothing in the model path posts a journal.

## Consequences

An AI change that publishes without human confirmation and a server-side re-validation is a stop condition. Supervised autonomy is the product term. The product does not claim AGI.
