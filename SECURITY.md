# Security

Report a vulnerability privately to the repository owner (`sindhu-bharadwaj-dev`). Do not open a public issue, pull request, or chat message that includes exploit detail, credentials, or customer financial data.

## What to include

- Affected package and version, or the git revision
- The risk class you believe applies (see `docs/sdlc.md`)
- A description that lets the owner reproduce the issue without live customer data

## Out of scope

The demo password published in the README (`nexora-demo-2026`, overridable with `NEXORA_DEMO_PASSWORD`) is a local seed credential. It is not a production secret. CI database passwords in `.github/workflows/ci.yml` exist only inside the GitHub Actions job and are not production credentials.

## Handling

The owner acknowledges the report, decides the risk class, and fixes it through a pull request. A production defect follows the hotfix path in `docs/github-workflow.md`. Do not patch posted journals in place.
