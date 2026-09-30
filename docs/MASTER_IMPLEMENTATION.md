# Financial Ecosystem — Master Implementation

This is the build contract for the product. The constitution in this file overrides a sprint plan, a screen, or a model response. Specs V1–V13 describe the destination. This document says what is already true in the repository, what to build next, and the gate that must pass before the next slice starts.

Engine version today: `fe-kernel-0.1.0`.

## 1. Constitution

1. The server-side Financial Kernel is the only source of financial truth.
2. Material calculations are deterministic and covered by golden tests. An LLM never emits a final number.
3. AI proposes, explains, and cites. The kernel calculates and records.
4. Every material number has lineage: engine version, input hash, source facts, and the actor when a human published it.
5. Posted journals, audit events, calculation runs, and published versions are immutable. Corrections are reversals or new versions.
6. The browser and Excel display server results. They do not own totals, and the API recomputes every total it accepts.
7. Scenarios, models, valuations, statements, and board packs are versioned objects. A scenario projection copies the base and leaves the base unchanged.
8. Tenant isolation is absolute. Every business table carries `tenant_id`. Postgres row-level security is forced. Queries also filter by tenant.
9. Authorization, region checks, and financial safety fail closed.
10. Each tenant has one home region. A request for another region is rejected until an explicit cross-region design exists.

When a request conflicts with this list, refuse it and offer the compliant alternative.

## 2. Product end state

One operating path:

Raw financial data → accounting → statements → model → scenario → valuation → capital and transactions → board decision.

All of those objects hang off one tenant-scoped financial state. Publishing is a controlled transition. A failed calculation cannot be published.

The interface is a modern institutional workspace: dense, calm, tabular numbers, and a lineage inspector on every material figure. Visual direction lives in `UI-UX.md`. That document governs presentation. It does not move calculation into the client.

## 3. Baseline already in the repository

This slice is Gate G0. Do not rebuild it.

| Area | What exists |
|---|---|
| Kernel | Integer minor-unit money, balanced journals, reversal lines, three-statement derivation, year-end Gordon DCF, half-even FX translation, acyclic formula graph, intercompany elimination identity, publication transitions, scenario projection, fail-closed authorization |
| Persistence | `packages/db/migrations/0001_kernel_foundation.sql`: tenant, membership, legal entity, account, period, journal, journal line, audit event, calculation run, domain event. Triggers freeze posted journals, closed periods, and append-only tables. RLS is forced. App role is `nexora_app` with no delete on journals, lines, audit, runs, or domain events |
| API | Hono routes under `/v1` for tenants, memberships, entities, accounts, periods, journals, statements, DCF, and audit. Idempotency-Key on post. Expected-Version on reverse. Roles come from membership rows |
| Web | Next.js shell that renders `GET /health`. It does not import the kernel |
| Tests | Golden statements and DCF, FX rounding, graph cycles, publication block, RLS and immutability, HTTP tenant isolation |

### Kernel modules

`packages/kernel/src/`: `money`, `journal`, `statements`, `dcf`, `fx`, `graph`, `elimination`, `publication`, `scenario`, `period`, `authz`, `hash`, `errors`, `version`.

### API surface

Actor, tenant, and region come from a signed session cookie. Writes also need `x-csrf-token` and an allowed `Origin`. The `x-actor-id` / `x-region` / `x-tenant-id` header seam works only when `NEXORA_DEV_HEADERS=true`, and production refuses that flag. `PLATFORM_ADMIN_ACTOR_IDS` is the bootstrap allow-list for `POST /v1/tenants`. See `docs/operations.md`.

- `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`, `POST /auth/session/tenant`, `GET /auth/config`
- `POST /v1/tenants`
- `POST /v1/memberships`
- `POST /v1/entities`
- `POST /v1/accounts`
- `POST /v1/periods` and `POST /v1/periods/:id/close`
- `POST /v1/journals` and `POST /v1/journals/:id/reverse`
- `GET /v1/journals/:id`
- `GET /v1/entities/:entityId/periods/:periodId/statements`
- `POST /v1/valuations/dcf`
- `GET /v1/audit`
- `GET /health` (liveness) and `GET /ready` (store ping)

Stable error codes include `FIN_UNBALANCED_JOURNAL`, `FIN_PERIOD_CLOSED`, `FIN_IMMUTABLE_RECORD`, `FIN_STATEMENT_IMBALANCE`, `FIN_IDEMPOTENCY_MISMATCH`, `FIN_VERSION_CONFLICT`, `AUTH_SCOPE_DENIED`, `REGION_MISMATCH`, `FX_RATE_MISSING`, `CALC_CYCLE_DETECTED`, `VALUATION_INVALID_ASSUMPTION`, `PUBLISH_BLOCKED`.

### Decisions already locked

- Ledger storage is `numeric(38,0)` minor units. Analytical output is a 12-decimal-place string from `decimal.js` precision 40.
- Material hashes reject IEEE numbers and bigints. Inputs are decimal strings.
- Posting inserts a draft, writes lines, then updates status to `posted` once. A second update throws. A reversal is a new journal with `reverses_journal_id`. One reversal per original.
- Closed periods stay closed. Reversals land in a later open period.
- Retained earnings on the statement is a derived close. Source lines stay as posted.
- DCF convention is year-end. `FCF_(n+1) = FCF_n * (1+g)`. `TV = FCF_(n+1) / (WACC-g)`. WACC must exceed g. The client cannot submit enterprise value.
- FX keeps the source amount and returns a derived amount. Rounding is half-even. A missing rate fails.
- Formula cycles fail. There is no iterative solver in 0.1.0.
- Account currency is the entity functional currency. A journal in another currency is rejected until an explicit FX command exists.
- Dev with no `DATABASE_URL` uses embedded PGlite and applies the migrations on boot. Production requires `DATABASE_URL`. `pnpm --filter @nexora/api migrate` applies migrations as the owner role, tracked in `schema_migrations` with checksums. The API refuses to boot with pending or drifted migrations. In production it also refuses a superuser, `BYPASSRLS`, or table-owning login.

## 4. Target architecture

Stay a modular monolith until a boundary has production load behind it.

```
apps/web          Next.js 15. Display and commands. No financial math.
apps/api          Hono. Authz, region, idempotency, audit, orchestration.
packages/kernel   Pure functions. The only calculator.
packages/db       Drizzle schema, SQL migrations, RLS, triggers, ledger store.
```

Later packages, still calling the kernel:

| Package | Appears in |
|---|---|
| `packages/contracts` | G1. Zod and OpenAPI generated from one schema module so HTTP and the future Excel client share contracts |
| `packages/auth` | G1. Better Auth session → tenant membership. Header actor ids retire |
| Job runner | G4. Inngest or BullMQ for calculation runs over the graph limit. The worker calls the kernel and writes a calculation run. It does not invent a second engine |

Redis is a cache of kernel outputs keyed by `hash(modelVersion, inputHash, rateSetVersion, engineVersion)`. A cache miss recomputes. A cache hit still returns the stored run id.

OpenTelemetry spans already wrap journal post, reversal, and DCF. They export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and the SDK packages are installed; neither is the case in the repository today. Spans carry `kernel.code` on failure and never carry raw financial payloads in logs.

### Region

`tenant.home_region` is the write locus. G0 rejects a mismatched `x-region`. Multi-region read replicas are a later G11 design with an explicit routing table. Until then, one region serves that tenant.

## 5. Canonical objects

Every business row has `tenant_id`. Versioned financial objects also store engine version and input hash.

| Object | Identity | Rule |
|---|---|---|
| Tenant | `tenant_id` | Home region, status `active` or `suspended` |
| Membership | tenant + actor + role | Roles: owner, controller, viewer, auditor. `platform_admin` is not a membership role |
| Legal entity | tenant + entity | One functional currency. One retained-earnings account, set once |
| Account | tenant + entity + code | Report class and cash-flow class are data. They are not inferred by the client at read time |
| Period | tenant + entity + date range | No overlap. `open` → `closed` only |
| Journal | tenant + idempotency key | `draft` then `posted`. Posted is frozen |
| Statement set | derived | Not a second ledger. Built from posted lines |
| FX rate set | tenant + rate set version | Approved rates only. Original transaction currency is kept |
| Consolidation group | tenant + as-of date | Ownership is effective-dated. Eliminations carry evidence ids |
| Model version | tenant + model + version | Immutable after publication |
| Scenario | tenant + base version + scenario id | Base row is never updated |
| Calculation run | tenant + model version + input hash | Insert-only. `succeeded` or `failed` |
| Valuation | tenant + method + assumption version | DCF first. Comps later, fed by declared inputs |
| Instrument / cap table | tenant + legal entity + version | G7. Schedules reconcile to the penny |
| Board pack | tenant + published state ids | Can be built only from published objects |
| Audit event / domain event | append-only | Same transaction as the command they describe |

### Publication

Kernel states: `draft → validated → review → approved → published`, with `rejected` as a terminal side path. Published has no outbound transition.

UI labels from `UI-UX.md`:

| Kernel status | UI label |
|---|---|
| `draft` | Draft |
| `validated` | Draft, with a "checked" marker |
| `review` | In Review |
| `approved` | Approved |
| `published` | Published |
| `rejected` | Rejected |

Superseded is not a status mutation. A successor is a new row with `supersedes_id`. The prior published row stays `published`. The UI queries the successor and shows the label Superseded. Color plus text. Never color alone.

Maker-checker: the actor who moves an object to `review` cannot be the actor who moves it to `approved` for journal-close, valuation publish, and board-pack publish. Record actor, timestamp, decision, and policy version on the approval row.

### Lineage chain

```
Output → calculation run → model version → input versions → source facts → evidence → engine version
```

`GET /v1/lineage/:type/:id` is the contract. G0 stores the hash on journals and calculation runs. G2 exposes the chain. The statement response already returns `inputHash` and `engineVersion`. The UI inspector renders that payload. It does not recompute it.

### Financial state hash

G2 introduces `FinancialState`:

```
tenant, reporting period, entities, accounting basis, currencies,
ledger fact versions, adjustment versions, consolidation version,
model refs, publication status
```

`state_hash` covers those fields. Presentation metadata (sort, column width, thousands scaling) is excluded. Two equal states plus the same engine version produce the same statement output.

## 6. Rules that apply to every phase

### Money

- Persist minor units. Display with `formatMinor` on the server, then tabular figures in the UI.
- Thousands or millions is a view scale. The stored amount stays in minor units.
- One currency per journal until the FX command writes a derived fact beside the original.
- Mixed currencies on one statement fail with `FIN_CURRENCY_MISMATCH`.

### Commands

- Mutating routes take `Idempotency-Key`. Replay of the same payload returns the original record. A different payload returns `FIN_IDEMPOTENCY_MISMATCH`.
- Mutations of an existing version take `Expected-Version`.
- The service writes the audit event and the domain outbox event in the same transaction as the financial write.
- Domain events are facts. Consumers are idempotent. Order is guaranteed only inside one aggregate.

### Authorization

| Action | Roles |
|---|---|
| Provision tenant | platform admin allow-list, then Better Auth platform role |
| Grant membership | owner |
| Write entity, account, period, journal, valuation | owner, controller |
| Close period | owner, controller |
| Read journals and statements | owner, controller, viewer, auditor |
| Read audit | owner, controller, auditor |

A viewer who cannot see a supporting schedule gets an explicit locked state. The screen does not render a blank or a substitute number.

### UI non-negotiables

From `UI-UX.md`, applied as build rules:

- Persistent context bar: entity, period, scenario, currency, as-of date.
- Right inspector: lineage, assumptions, AI suggestions, comments. AI content uses a separate accent and the word Suggested.
- Draft, review, and published are separate surfaces. A published pack cannot be edited in place.
- Post, close, publish, and finalize require a confirmation that states the consequence.
- Keyboard path for ledger and model grids. WCAG 2.2 AA. Tabular numbers. Units always visible.
- The web app never imports `@nexora/kernel`.

### Testing bar for any new calculation

1. Pure function in `@nexora/kernel`.
2. Golden fixture with inputs, expected outputs, and tolerance written by hand.
3. Property or conservation check where the identity is simple (balance, reversal nets to zero, sources equal uses).
4. HTTP test that the client total is ignored or absent.
5. Tenant isolation test if a new table appears.
6. Immutability test if the new row is posted or published.

## 7. Gates

Build in this order. A gate opens when its exit criteria pass in CI.

| Gate | Outcome | Spec lineage |
|---|---|---|
| G0 | Kernel foundation, schema, RLS, posting API, health shell | V6 sprints 1–2, V7 slice. **Done** |
| G1 | A controller can keep books in the UI for one entity | V6 sprints 1–2 completed as a product, V8 financials |
| G2 | Statements and valuations publish as immutable versions with lineage | V7 publication and lineage |
| G3 | Two entities, FX, and eliminations produce a balanced group | V7 consolidation and FX |
| G4 | Model graph and scenarios. Base case stays unchanged | V7 calculation language, V6 sprint 4–5 |
| G5 | Valuation workspace on pinned runs. Failed runs cannot publish | V7 valuation |
| G6 | Board pack built only from published states | V8 reporting |
| G7 | Debt, equity, cap table. Sources equal uses | V11 |
| G8 | Import, mapping, reconciliation, normalization, QoE | V13 |
| G9 | AI explains and proposes against kernel citations | V9 |
| G10 | M&A, diligence, data room on published financial state | V10 |
| G11 | Jurisdictions, i18n, explicit multi-region | V12 |

Excel is a client of the same `/v1` contracts during G4–G5. It is not a parallel calculator and it does not get its own gate.

## 8. Phase plans

### G1 — Operable books

**Goal.** An owner or controller provisions a company, posts a period, and reads statements in the web app. The page shows the server minor units and the server-formatted amount.

**Kernel.** No new formulas. Add period-overlap and account-classification errors only if the UI discovers a missing code. Keep classification on the account row.

**Schema.** No new financial fact table. Optional: `display_name` preferences in a non-hashed settings table.

**API.** Read routes now exist and are tenant-scoped:

- `GET /v1/entities`
- `GET /v1/entities/:entityId/accounts`
- `GET /v1/entities/:entityId/periods`
- `GET /v1/entities/:entityId/journals?periodId=`

CORS allows the web origin (`WEB_ORIGIN`, default `http://localhost:3000`). `GET /openapi.json` is emitted from the Zod route schemas.

**Auth.** Done as signed HMAC session cookies backed by `auth_session` rows, with CSRF and scrypt passwords, rather than Better Auth. The header seam is dev-only behind `NEXORA_DEV_HEADERS`. SSO, OAuth, MFA, and password reset are not built. Membership still resolves role. `PLATFORM_ADMIN_ACTOR_IDS` remains only for the first platform operator, then becomes a real platform role. Region still comes from the tenant row, checked against the session's selected region.

**UI.** Shell with context bar and these screens:

- Admin: tenant home region (read-only after create), entities, members
- Chart of accounts
- Periods, with close confirmation
- Journal entry and journal list
- Statements: income, balance sheet, cash flow, retained earnings roll-forward
- Inspector bound to `inputHash` and `engineVersion`

Empty, error, and permission states are required. A viewer can open statements and cannot post. Posting shows the server balance check failure as `FIN_UNBALANCED_JOURNAL` without a client-side "suggested total."

**Exit.** The golden single-entity story in `apps/api/test/ledger.http.test.ts` can be performed in the browser. Refreshing the statement page returns the same `inputHash`.

### G2 — Published financial state

**Goal.** A statement set and a valuation run move through the publication machine. Published rows do not update.

**Kernel.** `assertTransition` and `assertCanPublish` already exist. Add `stateHash(input)` beside `hashMaterial`. Presentation fields are omitted from the hash by an allow-list, not a deny-list.

**Schema.**

- `financial_state` (tenant, period, entity scope, basis, currency, state_hash, status, engine_version)
- `approval` (object type, object id, actor, decision, policy version, timestamp)
- `lineage_edge` (from type/id, to type/id, relation)

Status changes append an approval and insert the next state version. They do not update a published row.

**API.**

- `POST /v1/financial-states`
- `POST /v1/financial-states/:id/transition`
- `GET /v1/lineage/:type/:id`

Transition to `published` calls `assertCanPublish`. Maker-checker is enforced in the service.

**UI.** Status chip using the label map above. Publish confirmation names the period, entity, and hash. Superseded versions list as history.

**Exit.** A failed DCF run stored by `POST /v1/valuations/dcf` cannot transition to published. Two identical inputs produce one hash. Audit contains the transition.

### G3 — Group, currency, consolidation

**Goal.** Two entities in different functional currencies publish one group balance sheet that balances, with eliminations tied to evidence.

**Kernel.** Extend, do not replace:

- Rate selection policy: account, period, rate type, basis → one rate-set version
- `translate` already returns a derived amount. Add a pure translation of a trial balance that plugs CTA to an explicit equity account
- `eliminateIntercompany` already requires balanced eliminations and evidence ids. Add NCI as an explicit policy input with its own golden fixture
- Ownership graph is effective-dated and resolved as-of the reporting date before translation

Missing rate → `FX_RATE_MISSING`. No silent fallback.

**Schema.** `fx_rate_set`, `fx_rate`, `ownership_edge`, `consolidation_group`, `elimination_entry`. Elimination lines reference evidence. Original journal currency columns stay.

**API.** `POST /v1/fx-rate-sets`, `POST /v1/consolidation-groups/:id/translate`, `POST /v1/consolidation-groups/:id/eliminate`. Group statements are a kernel result, stored as a calculation run.

**UI.** Group context in the context bar. Translation and elimination on separate steps so a user can see the rate set version. CTA is a labeled line, not a plug hidden in equity.

**Exit.** Fixture `two_entity_fx`: each entity trial balance balances, the FX plug reconciles, eliminations balance, group assets equal liabilities plus equity including NCI.

### G4 — Models and scenarios

**Goal.** A versioned model graph evaluates on the server. A downside scenario does not change the base.

**Kernel.** Grow `evaluateGraph` from binary formulas to the node types required for the first planning model:

`INPUT`, `FORMULA`, `LINK`, `TIMESERIES`, `AGGREGATE`, `OUTPUT`.

`ALLOCATION`, `DEBT_SCHEDULE`, `TAX`, and `VALUATION` nodes arrive with their own gates (G7 and G5), not as empty shells that return guesses.

Cycles still fail unless a future solver node declares tolerance, max iterations, and a convergence test. That solver does not exist in this gate.

Limits stay explicit: 10,000 nodes, depth 256. Over the limit, the API accepts the run, queues it, and the worker writes `succeeded` or `failed`. The HTTP handler never computes in the browser while it waits.

**Schema.** `model`, `model_version`, `model_node`, `assumption_set`, `scenario`. `model_version` is immutable once status is `published`. Scenario rows store overrides and `base_version_id`.

**API.**

- `POST /v1/models`
- `POST /v1/models/:id/versions`
- `POST /v1/models/:id/calculate`
- `POST /v1/scenarios`

Calculate persists a calculation run. The response is that run. Cache key: `hash(model_version_id, input_hash, rate_set_version, engine_version)`.

**UI.** Model workspace: grid plus assumption panel. Scenario manager: side-by-side, base column locked. Changed assumptions highlighted. Version selector in the context bar.

**Exit.** Fixture `scenario_base_downside`: base outputs unchanged after the downside run. Re-running the same version and inputs returns the same output strings and the same input hash.

### G5 — Valuation workspace

**Goal.** DCF is a published valuation object. Sensitivity is a set of kernel runs, not a client grid of formulas.

**Kernel.** `valueDcf` is the method. Add a sensitivity driver that calls it once per declared shock and stores each run. Comps, when added, take an explicit multiple and a metric already produced by a calculation run. The kernel multiplies. It does not fetch market data.

**Schema.** `valuation` points at assumption versions and calculation run ids. Status uses the publication machine.

**API.** `POST /v1/valuations` creates the object. `POST /v1/valuations/:id/calculate` runs the kernel. `POST /v1/valuations/:id/transition` publishes. Existing `POST /v1/valuations/dcf` remains as the direct compute path and still persists a run.

**UI.** Method name, WACC, g, explicit cash flows, and terminal policy `gordon_from_last_explicit` visible by default. Equity bridge: enterprise value, net debt, non-operating assets, other claims. Sensitivity table lists run ids.

**Exit.** The hand fixture (FCF 100, 110; WACC 10%; g 2%) still yields enterprise value `1340.909090909091` and equity value `1180.909090909091`. WACC ≤ g returns `VALUATION_INVALID_ASSUMPTION` and a failed run that cannot publish.

### G6 — Board and reporting

**Goal.** A board pack is a frozen composition of published statement, model, and valuation versions.

**Kernel.** No new arithmetic. The pack records the state hashes it includes. Rendering uses those hashes.

**Schema.** `report_pack` with status, cutoff timestamp, and the list of published object ids. After `published`, the row is immutable. A revised pack is a new version.

**API.** `POST /v1/report-packs`, `POST /v1/report-packs/:id/transition`, `GET /v1/report-packs/:id`.

**UI.** Presentation layout, data cutoff, and a locked banner after publish. Export is a rendering of the stored pack. Export does not recalculate.

**Exit.** A pack whose statement or valuation is still `draft` or `failed` is rejected. A published pack's hash list is stable across reads.

### G7 — Capital structure

**Goal.** Debt, equity, and cap table reconcile, and an LBO case conserves sources and uses.

**Kernel.** New pure modules, each with a golden fixture:

- Debt schedule: opening + draws − repayments + accrued interest = closing
- Cap table: shares, options, convertibles, fully diluted totals
- LBO: sources = uses, debt schedule ties, exit bridge, returns

These write calculation runs. They do not silently post journals. Funding a draw into the books is a separate, authorized journal command that references the schedule version.

**Schema.** `instrument`, `debt_terms`, `cap_table_version`, `holding`. Versions are immutable after approval.

**UI.** Capital section in the nav. Schedule and cap table show as-of date and version. Waterfall is a kernel output.

**Exit.** Fixtures from V11 pass: schedule identity, sources = uses, and the journal that records a draw matches the schedule line it cites.

### G8 — Onboarding, normalization, QoE

**Goal.** A company can land source files, map them to the chart, reconcile, and record quality-of-earnings adjustments as versioned facts.

**Kernel.** Mapping does not calculate. Normalization adjustments are explicit journals or explicit non-posted bridge lines with lineage. They never overwrite posted actuals. QoE output is a bridge: reported → adjustments → normalized, each step hashed.

**Schema.** `import_batch`, `source_row`, `account_mapping`, `reconciliation`, `normalization_adjustment`. Idempotency key on the import batch so a duplicate file creates one batch.

**API.** `POST /v1/imports`, `POST /v1/mappings`, `POST /v1/reconciliations/:id/resolve`.

**UI.** Mapping review before any post. Unmapped rows block posting. Reconciliation exceptions are a queue, not a silent drop.

**Exit.** Fixture `import_idempotency`: the same file twice yields one batch. A normalized EBITDA bridge traces every adjustment to a source row and an actor.

### G9 — Controlled AI

**Goal.** An assistant can explain a published number and propose a journal or assumption change. It cannot write a total.

**Boundary.**

- Tools available to the model are read APIs plus `propose` commands.
- A proposal is a draft object. Accepting it runs the normal kernel command under the user's authority and idempotency key.
- The model response schema requires citations: calculation run id, statement hash, or document id. Uncited numeric claims are discarded before they reach the UI.
- Prompt text is not a financial input. If the user types a number, the server still recomputes from stored facts.

**UI.** Assistant is contextual on the current entity, period, and scenario. Cards say Suggested. Accept and reject are explicit. The inspector can show the proposal beside the published figure.

**Exit.** An evaluation set where the model is instructed to "just give EBITDA" still returns a kernel value or a refusal. A proposal to post an unbalanced journal fails `FIN_UNBALANCED_JOURNAL` on accept. Cross-tenant retrieval returns nothing.

### G10 — Transactions and diligence

**Goal.** A deal workspace reads the published financial state of the target and stores deal-specific assumptions as scenarios.

**Kernel.** Purchase accounting, sources and uses, and a deal model are kernel runs. The data room stores documents and links them as evidence on lineage edges. Document text is not a ledger.

**Rule.** Deal math that needs normalized EBITDA uses the G8 bridge. It does not retype figures into the model.

**Exit.** A synthetic deal loads a published G2/G3 state, applies a scenario, and produces a hashed output. The base books are unchanged.

### G11 — Enterprise

**Goal.** The same kernel serves more than one jurisdiction and an explicit residency story.

- Locale formatting is presentation. Minor units remain the stored form.
- Chart mappings per reporting basis (local GAAP vs group basis) are versioned mappings, not forked ledgers.
- i18n and RTL follow `UI-UX.md`. Number formatting uses the locale for display and the kernel string for the value.
- A second region is a deployment with the tenant's home region pinned. Cross-region queries are a designed API, turned on per tenant, and still fail closed when the routing row is missing.

**Exit.** A jurisdiction fixture closes the books under one basis and a mapped group basis, with both hashes stored. A request to the wrong region still returns `REGION_MISMATCH`.

## 9. Screen build order

Navigation from `UI-UX.md`, wired only when its gate exists.

| Screen | Gate | Server dependency |
|---|---|---|
| Health shell | G0 | `GET /health` (done) |
| Admin, chart, journals, statements | G1 | Current ledger API |
| Publish and lineage inspector | G2 | Financial state and `/v1/lineage` |
| Group and FX | G3 | Consolidation runs |
| Model workspace, scenario compare | G4 | Calculation runs |
| Valuation workspace | G5 | Valuation object |
| Board pack | G6 | Report pack |
| Capital | G7 | Schedules and cap table |
| Import and QoE bridge | G8 | Import batches |
| Assistant | G9 | Proposals plus citations |
| Deals | G10 | Published state plus deal scenario |
| Locale, basis, region admin | G11 | Mappings and residency |

Dashboard KPIs appear in G2, and only from published state. A dashboard tile without a run id does not ship.

## 10. What each new migration must include

- `tenant_id` on every business table, plus an index on tenant plus the business key
- RLS enabled and forced, policy `tenant_id::text = app_tenant_id()`
- Grants for `nexora_app` limited to the commands that role may perform
- A trigger that blocks update and delete once the row is posted or published
- A uniqueness rule for idempotency keys where the command is retried
- A Drizzle table in `packages/db/src/schema.ts` with the same name the SQL migration creates
- A PGlite test that a second tenant cannot read the row and that a posted row cannot change

Schema change pattern: expand, migrate, contract. Do not rename a posted financial column in place.

## 11. Near-term build sequence

Gates G2–G11 are implemented in the kernel, migration `0002_program.sql`, `/v1` program routes, and the `/program` workspace. `apps/api/test/program.http.test.ts` is the exit fixture: one state hash, maker-checker, failed valuations excluded from the board pack, CTA, an unchanged scenario base, sources equal uses, import idempotency, discarded uncited numbers, and two basis hashes. HTTP tests run through the signed-session path (`apps/api/test/harness.ts`); `auth.http.test.ts` covers forged headers, CSRF, expiry, rate limits, and body limits.

Suggested order inside the original G1 increment:

1. List endpoints and OpenAPI.
2. Better Auth session in front of the existing authorization matrix.
3. Web app shell: context bar, nav, permission-denied state.
4. Chart of accounts, periods, journal post, statement view.
5. Browser pass of the golden company already covered by the HTTP test.

Do not start the model graph, the assistant, or deal rooms in that increment. The statement inspector can show the hash that G0 already returns; the full lineage graph waits for G2.

## 12. Refusal rules for implementation work

- A client-computed total submitted as the value to store is rejected. The kernel result is stored.
- A posted row update is rejected. Offer a reversal or a new version.
- Reopening a closed period is rejected. Offer a journal in the next open period.
- An AI tool that writes a journal without the user's accept step is rejected. The accept step calls the normal post command.
- A second calculator in the web bundle, an Excel add-in, or a Python notebook is rejected. Those clients call `/v1`.
- A consolidation that overwrites entity books with group currency is rejected. Translation writes derived facts.

## 13. Definition of done for the program

The program is complete when a synthetic company can move from an imported trial balance to published statements, a reproducible valuation, a capital structure that ties, and a board pack whose every figure opens to a calculation run and an engine version. The same inputs and the same engine build reproduce the same outputs. A failed run never appears in that pack. A user in another tenant cannot see any of it.

## 14. LedgerMind is the legacy product, not the kernel

`C:\xampp\htdocs\My Projects\LedgerMind` is the product reference for navigation and user tasks. `docs/Financial_Ecosystem_V1_V13_Audit.zip` audits that tree at `426751887` against `docs/Financial_Ecosystem_V1_V13_Master.zip`. Weighted coverage there is 31.9%. The audit’s conclusion is that LedgerMind is a forecasting application plus a mutable single-pair ledger, not a V3/V7 kernel.

Reuse LedgerMind for information architecture only: Connect Data, Financials (actuals, projections, budget), Valuation, Transactions (LBO, sources and uses, debt, returns), Capital, Operations, and Board Packs. Those labels already map onto this repository’s `/`, `/books`, and `/program` routes.

Do not port LedgerMind’s financial execution. The audit’s blocking defects are closed here by the existing kernel, and copying that code would reopen them.

| Audit item | LedgerMind | This repository |
|---|---|---|
| P0-02 Client grids stored as forecasts | `PROJECTION_STRICT_SAVE` defaults off | The kernel recalculates. A failed run cannot publish |
| P0-03 Posted rows updated and deleted | `PUT`/`DELETE` on `transactions` | Posted journals are frozen. Corrections are reversals |
| P0-04 Period lock incomplete | Delete and recurring bypass the lock | A closed period rejects mutation |
| P0-05 Mixed currency summed | GL sums `amount` across currencies | FX translation is explicit and plugs CTA |
| P0-08 Statement replaced in place | `parsedData` overwritten | Publication inserts a new version |
| P1-02 FX and CTA | Absent | Kernel translation with a golden case |
| P1-03 Consolidation | Claimed, not built | Elimination identity; NCI plus parent equals subsidiary equity |
| Float projections | JavaScript numbers in `shared/projections` | Integer minor units or decimal.js |
| AI overwrites accounts | Confidence above 0.7 replaces the user’s accounts | Suggestions stay labeled Suggested until the user accepts |

Product copy must match this table. Comparables, precedent transactions, live bank connect, and live accounting-system connect stay unavailable until a kernel method exists. A printed cash-flow page in an upload is not the cash flow. The kernel derives cash flow from classified activity.

Next work follows the audit roadmap after the kernel, and only as new kernel functions with golden tests: thirteen-week cash, an approved normalization ledger, and a QoE case on those adjustments. Do not restore LedgerMind’s removed 13-week tab or its deleted data room. Do not merge LedgerMind branches into this tree.
