# Nexora MVP report

The studio is the governed finance workspace for Nazareno Services LLC. Sign in at [http://127.0.0.1:4317](http://127.0.0.1:4317) as `sindhu` / `nexora-demo-2026`. The API is `http://127.0.0.1:8787` with embedded PGlite and no secrets. Engine version is `fe-kernel-0.2.0`.

## What was built

- Kernel formulas, each with a golden test: driver forecast, 13-week cash, variance, and model-text grounding. Income statements are period movement. Prior earnings roll into retained earnings. Material hashes still reject IEEE numbers.
- Migration `0004_workspace.sql` for proposals, documents, flags, and support windows, with row-level security. Baselining an existing database records `workspace_record` instead of creating it twice.
- `GET /v1/workspace` recomputes statements, forecast, cash, variance, the earnings bridge, the board pack, and KPIs in the kernel. The browser displays those minor-unit strings. It does not import `@nexora/kernel`.
- Demo seed posts a balanced reconstruction of Nazareno Services (Jan 2025–Sep 2026, USD, `us-east-1`) through the ledger. Actors: `sindhu` (owner), `controller`, `viewer`, `platform-admin`.
- Studio screens: onboarding and reconciliation certificate, three-statement grid (sort, filter, pinned label, virtualized rows, CSV export, journal drill-down), driver forecast with base and downside, 13-week cash, variance, QoE bridge, board pack with lineage, CFO dashboard, command palette, copilot drawer, approvals inbox, organization admin, and platform admin.
- Copilot tools run before the model. `groundModelText` rejects any number that is not in the kernel or document corpus. With no `AI_API_KEY` or `OPENAI_API_KEY`, the answer is labeled mock. With a key, the Vercel AI SDK calls the configured model and the same validator runs.
- Agents only file proposals. A viewer cannot accept them. Platform admin can change tenant status, grant four-hour auditor support access, and toggle flags. Platform admin has no default financial access.
- CI runs typecheck, unit tests, the web build, and Playwright.

## What is stubbed

- Retrieval is in-process hybrid keyword plus a hashed-token vector stored as JSON. `pgvector` is not created in the shared migration because the stock Postgres 17 image has no extension.
- The reconciliation certificate subtracts kernel ending cash from itself, so the difference is zero. Bank PDF totals are not parsed. Workbooks and PDFs stay out of git. Short excerpts live in `apps/api/src/demo/catalog.ts`.
- The statement grid is monthly statement totals, not an account-level trial balance.
- The bridge starts from kernel net income. The demo books have no depreciation, so the label is normalized earnings.
- Excel, Tally, and Zoho are health rows or a flag. They do not sync.
- The company directory and support-access expiry live in process memory, the same way the ephemeral PGlite store does.
- Support access is a time-boxed auditor membership. It is not an impersonation bypass of row-level security.
- Valuation, capital, and deals remain on the existing `/program` routes. The Gate G0 shell remains at `/classic`.

## Tests

| Command | Result |
| --- | --- |
| `pnpm test` | Passed. Kernel 40, database 7, API 45 passed and 1 skipped, web 3. |
| `pnpm typecheck` | Passed. |
| `pnpm build` | Passed. Next.js 15 production build. |
| `pnpm --filter @nexora/web test:e2e` | Passed. Owner workspace and mock copilot, viewer cannot accept, platform admin sees Tally and the Excel flag, plus the screenshot pass. |

## Screenshots

Light and dark captures are in `/opt/cursor/artifacts/screenshots/`:

- `dashboard-light.png`, `dashboard-dark.png`
- `statements-light.png`, `statements-dark.png`
- `forecast-light.png`, `forecast-dark.png`
- `cash-light.png`, `cash-dark.png`
- `qoe-light.png`, `qoe-dark.png`
- `copilot-approvals-light.png`, `copilot-approvals-dark.png`
- `admin-light.png`, `admin-dark.png`
- `palette-light.png`, `palette-dark.png`

## Polish pass

The studio shell is a grouped sidebar with icons, a collapse control, and a workspace switcher. The top bar is compact switchers, a search field with a command-palette hint, and an avatar menu. KPI cards show kernel period-over-period deltas and sparklines. The revenue and cash chart draws every month with area fills, currency axis ticks, and click-through to that period's statements. Proposal text is currency, with status chips, filters, and agent icons. The copilot is a chat with streaming text, citation chips, suggested prompts, and a mock-mode badge. The earnings bridge is a waterfall. Charts do not animate, so the full series is on screen immediately. The Next.js dev indicator is off.

## Next

1. Parse bank PDFs and tie the reconciliation certificate to those totals.
2. Add an account-level trial balance under the statement totals, still computed by the kernel.
3. Put embeddings in `pgvector` on a Postgres image that has the extension, and keep the in-process fallback for PGlite.
4. Persist the company directory and support grants in Postgres so they survive a restart when `DATABASE_URL` is set. Seed that path explicitly. The demo seed currently runs only without `DATABASE_URL`.
5. Connect Excel, Tally, and Zoho as proposal producers, not as writers of posted journals.
6. Extend QoE when the books carry depreciation, interest, and taxes, and keep the bridge starting from a kernel total.
