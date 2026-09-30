# ADR 0006: Mock-mode AI

- Status: Accepted
- Date: 2026-09-30

## Context

Local development, CI, and demos cannot depend on a hosted model or a secret. The grounding rule still has to hold when no model is called.

## Decision

When `AI_API_KEY` and `OPENAI_API_KEY` are unset, the copilot answers from the same kernel corpus in mock mode and labels the answer. When a key is set, the API calls the OpenAI-compatible chat API (`gpt-4o-mini` by default, optional `AI_BASE_URL`) and still rejects ungrounded numbers.

## Consequences

Playwright and the demo run with no model credential. Mock mode is visible in the copilot. A missing key fails closed to mock mode rather than inventing a live call.
