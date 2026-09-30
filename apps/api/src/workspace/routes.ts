import {
  assertSameRegion,
  assertTenantActive,
  authorize,
  buildCashForecast,
  buildQoeBridge,
  buildStatements,
  currencyScale,
  explainVariance,
  forecastScenario,
  formatMinor,
  isZeroMoney,
  KernelError,
  money,
  subtractMoney,
  type ClassifiedLine,
  type Role,
} from "@nexora/kernel";
import type { LedgerStore, PostedActivityLine } from "@nexora/db";
import type { Hono } from "hono";
import { z } from "zod";

import { answerCopilot, isAgent } from "../copilot/answer.js";
import { cashWeekInputs, PLAN_BUDGET, PLANNING_DRIVERS } from "../demo/books.js";
import { readActor, type ActorContext, type AppEnv } from "../http.js";
import { createLedgerService } from "../service.js";
import type { CompanyDirectory } from "./directory.js";

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const forecastSchema = z.object({
  revenueMinor: decimal,
  growthRate: decimal,
  grossMargin: decimal,
  opexMinor: decimal,
  scenarioGrowthRate: decimal.optional(),
});
const decisionSchema = z.object({ decision: z.enum(["accepted", "rejected"]) });
const copilotSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  agent: z.string().trim().default("general"),
});
const memberSchema = z.object({ actorId: z.string().trim().min(1).max(64), role: z.enum(["owner", "controller", "viewer", "auditor"]) });
const statusSchema = z.object({ status: z.enum(["active", "suspended"]) });
const supportSchema = z.object({ tenantId: z.uuid(), hours: z.number().int().min(1).max(24), reason: z.string().trim().min(1).max(240) });
const flagSchema = z.object({ enabled: z.boolean() });

export interface WorkspaceDeps {
  readonly store: LedgerStore;
  readonly directory: CompanyDirectory;
  readonly platformAdminActorIds: readonly string[];
}

export function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: WorkspaceDeps): void {
  app.get("/v1/workspace/companies", async (c) => {
    const actor = readActor(c);
    const now = Date.now();
    const companies = deps.directory.list().filter((card) => {
      const member = card.members.some((item) => item.actorId === actor.actorId);
      const support = card.members.some((item) => item.actorId === actor.actorId && item.role === "auditor");
      return member || support || deps.platformAdminActorIds.includes(actor.actorId);
    });
    return c.json({
      companies: companies.map((card) => ({ ...card, support: supportActive(card, actor.actorId, now) })),
      demoPasswordHint: "nexora-demo-2026",
    });
  });

  app.get("/v1/workspace", async (c) => c.json(await snapshot(deps, readActor(c))));

  app.post("/v1/workspace/forecast", async (c) => {
    const actor = readActor(c);
    const body = forecastSchema.parse(await c.req.json());
    const view = await snapshot(deps, actor);
    if (!view.permissions.canWrite) {
      throw new KernelError("AUTH_SCOPE_DENIED", "Viewers cannot change drivers");
    }
    const drivers = await deps.store.listWorkspaceRecords(actor.tenantId ?? "", "drivers");
    const current = drivers[0];
    if (current) {
      await deps.store.updateWorkspaceRecord({
        tenantId: actor.tenantId ?? "",
        id: current.id,
        status: "active",
        payload: { ...body },
        updatedAt: new Date().toISOString(),
        audit: audit(actor, current.id, "DriversUpdated"),
      });
    }
    return c.json(await snapshot(deps, actor));
  });

  app.post("/v1/workspace/proposals/:id/decide", async (c) => {
    const actor = readActor(c);
    const body = decisionSchema.parse(await c.req.json());
    const view = await snapshot(deps, actor);
    if (!view.permissions.canWrite) {
      throw new KernelError("AUTH_SCOPE_DENIED", "Viewers cannot decide proposals");
    }
    const proposals = await deps.store.listWorkspaceRecords(actor.tenantId ?? "", "proposal");
    const proposal = proposals.find((item) => item.id === c.req.param("id"));
    if (!proposal) throw new KernelError("FIN_NOT_FOUND", "Proposal not found");
    await deps.store.updateWorkspaceRecord({
      tenantId: actor.tenantId ?? "",
      id: proposal.id,
      status: body.decision,
      payload: { ...proposal.payload, decidedBy: actor.actorId, decidedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
      audit: audit(actor, proposal.id, "ProposalDecided"),
    });
    return c.json(await snapshot(deps, actor));
  });

  app.post("/v1/copilot", async (c) => {
    const actor = readActor(c);
    const body = copilotSchema.parse(await c.req.json());
    const agent = isAgent(body.agent) ? body.agent : "general";
    const view = await snapshot(deps, actor);
    const documents = await deps.store.listWorkspaceRecords(actor.tenantId ?? "", "document");
    const answer = await answerCopilot({
      message: body.message,
      agent,
      facts: {
        engineVersion: view.engineVersion,
        statementHash: view.latest.inputHash,
        revenue: view.latest.revenueMinor,
        expenses: view.latest.expensesMinor,
        netIncome: view.latest.netIncomeMinor,
        endingCash: view.latest.endingCashMinor,
        currency: view.context.currency,
        periodLabel: view.context.periodLabel,
        entityName: view.context.entityName,
      },
      chunks: documents.flatMap((document) => {
        const embedding = document.payload.embedding;
        const title = text(document.payload.title);
        const bodyText = text(document.payload.body);
        if (!Array.isArray(embedding) || title.length === 0) return [];
        return [{ id: text(document.payload.slug) || document.id, title, text: bodyText, embedding: embedding.filter((value): value is number => typeof value === "number") }];
      }),
      apiKey: envKey(),
      model: process.env.AI_MODEL?.trim() || "gpt-4o-mini",
      baseURL: process.env.AI_BASE_URL?.trim() || null,
    });
    const runId = crypto.randomUUID();
    await deps.store.insertWorkspaceRecord({
      tenantId: actor.tenantId ?? "",
      id: runId,
      kind: "ai_run",
      status: answer.accepted ? "grounded" : "grounding_failure",
      payload: { agent, mode: answer.mode, rejected: [...answer.rejectedNumbers], prompt: body.message },
      createdAt: new Date().toISOString(),
      audit: audit(actor, runId, "CopilotAnswered"),
    });
    if (answer.proposal && view.permissions.canWrite) {
      const proposalId = crypto.randomUUID();
      await deps.store.insertWorkspaceRecord({
        tenantId: actor.tenantId ?? "",
        id: proposalId,
        kind: "proposal",
        status: "suggested",
        payload: { ...answer.proposal, agent },
        createdAt: new Date().toISOString(),
        audit: audit(actor, proposalId, "ProposalSuggested"),
      });
    }
    return c.json({ ...answer, runId });
  });

  app.post("/v1/admin/members", async (c) => {
    const actor = readActor(c);
    const body = memberSchema.parse(await c.req.json());
    const roles = await rolesFor(deps.store, actor);
    authorize(roles, "membership.grant");
    const ledger = createLedgerService(deps.store, deps.platformAdminActorIds);
    await ledger.grantMembership(actor, body);
    const card = deps.directory.list().find((item) => item.tenantId === actor.tenantId);
    if (card) {
      deps.directory.upsert({
        ...card,
        members: [...card.members.filter((item) => item.actorId !== body.actorId), { actorId: body.actorId, role: body.role }],
      });
    }
    return c.json(await snapshot(deps, actor));
  });

  app.get("/v1/admin/platform", async (c) => c.json(await platformView(deps, readActor(c))));

  app.post("/v1/admin/tenants/:id/status", async (c) => {
    const actor = readActor(c);
    requirePlatform(deps, actor);
    const body = statusSchema.parse(await c.req.json());
    const tenantId = z.uuid().parse(c.req.param("id"));
    await deps.store.setTenantStatus({
      tenantId,
      status: body.status,
      audit: audit({ ...actor, tenantId }, crypto.randomUUID(), "TenantStatusChanged"),
    });
    const card = deps.directory.list().find((item) => item.tenantId === tenantId);
    if (card) deps.directory.upsert({ ...card, status: body.status });
    return c.json(await platformView(deps, actor));
  });

  app.post("/v1/admin/support", async (c) => {
    const actor = readActor(c);
    requirePlatform(deps, actor);
    const body = supportSchema.parse(await c.req.json());
    const membershipId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + body.hours * 60 * 60 * 1000).toISOString();
    await deps.store.grantMembership({
      tenantId: body.tenantId,
      membershipId,
      actorId: actor.actorId,
      role: "auditor",
      audit: audit({ ...actor, tenantId: body.tenantId }, membershipId, "SupportGranted"),
    });
    const id = crypto.randomUUID();
    await deps.store.insertWorkspaceRecord({
      tenantId: body.tenantId,
      id,
      kind: "support",
      status: "active",
      payload: { actorId: actor.actorId, membershipId, expiresAt, reason: body.reason },
      createdAt: new Date().toISOString(),
      audit: audit({ ...actor, tenantId: body.tenantId }, id, "SupportGranted"),
    });
    const card = deps.directory.list().find((item) => item.tenantId === body.tenantId);
    if (card && !card.members.some((item) => item.actorId === actor.actorId)) {
      deps.directory.upsert({ ...card, members: [...card.members, { actorId: actor.actorId, role: "auditor" }] });
    }
    return c.json(await platformView(deps, actor));
  });

  app.post("/v1/admin/flags/:id", async (c) => {
    const actor = readActor(c);
    requirePlatform(deps, actor);
    const body = flagSchema.parse(await c.req.json());
    const flagId = z.uuid().parse(c.req.param("id"));
    const tenantId = deps.directory.list()[0]?.tenantId;
    if (!tenantId) throw new KernelError("FIN_NOT_FOUND", "No tenant");
    const flags = await deps.store.listWorkspaceRecords(tenantId, "flag");
    const flag = flags.find((item) => item.id === flagId);
    if (!flag) throw new KernelError("FIN_NOT_FOUND", "Flag not found");
    await deps.store.updateWorkspaceRecord({
      tenantId,
      id: flag.id,
      status: body.enabled ? "active" : "off",
      payload: { ...flag.payload, enabled: body.enabled },
      updatedAt: new Date().toISOString(),
      audit: audit({ ...actor, tenantId }, flag.id, "FlagChanged"),
    });
    return c.json(await platformView(deps, actor));
  });
}

export async function expireSupportGrants(store: LedgerStore, tenantId: string, actorId: string, correlationId: string): Promise<void> {
  const grants = await store.listWorkspaceRecords(tenantId, "support");
  const now = Date.now();
  for (const grant of grants) {
    if (text(grant.payload.actorId) !== actorId || grant.status !== "active") continue;
    const expires = Date.parse(text(grant.payload.expiresAt));
    const membershipId = text(grant.payload.membershipId);
    if (!Number.isFinite(expires) || expires > now || membershipId.length === 0) continue;
    await store.deleteMembership({
      tenantId,
      membershipId,
      audit: {
        eventId: crypto.randomUUID(),
        eventType: "SupportExpired",
        aggregateType: "membership",
        aggregateId: membershipId,
        actorId,
        correlationId,
        occurredAt: new Date().toISOString(),
        payload: { tenantId },
      },
    });
    await store.updateWorkspaceRecord({
      tenantId,
      id: grant.id,
      status: "expired",
      payload: grant.payload,
      updatedAt: new Date().toISOString(),
      audit: {
        eventId: crypto.randomUUID(),
        eventType: "SupportExpired",
        aggregateType: "workspace_record",
        aggregateId: grant.id,
        actorId,
        correlationId,
        occurredAt: new Date().toISOString(),
        payload: {},
      },
    });
  }
}

async function snapshot(deps: WorkspaceDeps, actor: ActorContext) {
  const tenantId = actor.tenantId;
  if (!tenantId) throw new KernelError("AUTH_SCOPE_DENIED", "Choose a company first");
  const tenant = await deps.store.getTenant(tenantId);
  if (!tenant) throw new KernelError("FIN_NOT_FOUND", "Tenant not found");
  assertSameRegion(tenant.homeRegion, actor.region);
  assertTenantActive(tenant.status);
  const roles = await deps.store.listRoles(tenantId, actor.actorId);
  authorize(roles, "statement.read");
  const entities = await deps.store.listEntities(tenantId);
  const entity = entities[0];
  if (!entity?.retainedEarningsAccountId) throw new KernelError("FIN_NOT_FOUND", "Entity is not ready");
  const periods = [...(await deps.store.listPeriods(tenantId, entity.entityId))].sort((left, right) => left.startDate.localeCompare(right.startDate));
  const accounts = await deps.store.listAccounts(tenantId, entity.entityId);
  const activity = await deps.store.listPostedActivity(tenantId, entity.entityId);
  const accountName = new Map(accounts.map((account) => [account.accountId, `${account.code} ${account.name}`]));
  const activityPeriods = periods.filter((period) => period.startDate >= "2025-01-01");
  const series = activityPeriods.map((period) => {
    const statement = buildStatements({
      currency: entity.functionalCurrency,
      retainedEarningsAccountId: entity.retainedEarningsAccountId ?? "",
      lines: classify(activity, period.periodId, period.startDate),
    });
    return { period, statement };
  });
  const latest = series.at(-1);
  if (!latest) throw new KernelError("FIN_NOT_FOUND", "No statement periods");
  const currency = entity.functionalCurrency;
  const driversRecord = (await deps.store.listWorkspaceRecords(tenantId, "drivers"))[0];
  const drivers = {
    revenueMinor: text(driversRecord?.payload.revenueMinor) || PLANNING_DRIVERS.revenueMinor,
    growthRate: text(driversRecord?.payload.growthRate) || PLANNING_DRIVERS.growthRate,
    grossMargin: text(driversRecord?.payload.grossMargin) || PLANNING_DRIVERS.grossMargin,
    opexMinor: text(driversRecord?.payload.opexMinor) || PLANNING_DRIVERS.opexMinor,
  };
  const scenarioGrowth = text(driversRecord?.payload.scenarioGrowthRate) || "0";
  const forecast = forecastScenario({ ...drivers, periods: 12 }, { growthRate: scenarioGrowth });
  const cashBase = buildCashForecast({
    currency,
    openingCashMinor: latest.statement.cashFlow.endingCashMinor,
    minimumCashMinor: "25000000",
    weeks: cashWeekInputs("base"),
  });
  const cashDownside = buildCashForecast({
    currency,
    openingCashMinor: latest.statement.cashFlow.endingCashMinor,
    minimumCashMinor: "25000000",
    weeks: cashWeekInputs("downside"),
  });
  const variance = explainVariance({
    lines: [
      { key: "revenue", label: "Revenue", kind: "revenue", actualMinor: latest.statement.incomeStatement.revenueMinor, planMinor: PLAN_BUDGET.revenueMinor },
      { key: "expenses", label: "Expenses", kind: "expense", actualMinor: latest.statement.incomeStatement.expensesMinor, planMinor: PLAN_BUDGET.expensesMinor },
      { key: "net", label: "Net income", kind: "profit", actualMinor: latest.statement.incomeStatement.netIncomeMinor, planMinor: PLAN_BUDGET.netIncomeMinor },
    ],
  });
  const proposals = await deps.store.listWorkspaceRecords(tenantId, "proposal");
  const accepted = proposals.filter((item) => item.status === "accepted" && text(item.payload.amount).length > 0);
  const qoeRaw = buildQoeBridge({
    reported: latest.statement.incomeStatement.netIncomeMinor,
    adjustments: accepted.map((item) => ({
      adjustmentId: item.id,
      sourceRowId: text(item.payload.sourceRowId) || item.id,
      actorId: text(item.payload.decidedBy) || "sindhu",
      amount: text(item.payload.amount),
    })),
  });
  const qoe = {
    ...qoeRaw,
    reported: asMinor(qoeRaw.reported),
    adjustmentsTotal: asMinor(qoeRaw.adjustmentsTotal),
    normalized: asMinor(qoeRaw.normalized),
    steps: qoeRaw.steps.map((step) => ({ ...step, amount: asMinor(step.amount) })),
  };
  const bankGap = subtractMoney(money(currency, latest.statement.cashFlow.endingCashMinor), money(currency, latest.statement.cashFlow.endingCashMinor));
  const journals = await deps.store.listJournals(tenantId, entity.entityId, null);
  let auditEvents: { eventId: string; eventType: string; occurredAt: string; actorId: string; aggregateType: string }[] = [];
  let auditLocked = false;
  try {
    authorize(roles, "audit.read");
    auditEvents = (await deps.store.listAudit(tenantId)).slice(0, 80).map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      actorId: event.actorId,
      aggregateType: event.aggregateType,
    }));
  } catch {
    auditLocked = true;
  }
  const policies = await deps.store.listWorkspaceRecords(tenantId, "policy");
  const documents = await deps.store.listWorkspaceRecords(tenantId, "document");
  const canWrite = roles.includes("owner") || roles.includes("controller");
  return {
    engineVersion: latest.statement.engineVersion,
    permissions: { roles, canWrite, auditLocked },
    context: {
      tenantId,
      tenantName: tenant.name,
      region: tenant.homeRegion,
      entityId: entity.entityId,
      entityName: entity.legalName,
      currency,
      periodId: latest.period.periodId,
      periodLabel: latest.period.endDate,
      scenario: "Base",
    },
    latest: {
      inputHash: latest.statement.inputHash,
      revenueMinor: latest.statement.incomeStatement.revenueMinor,
      expensesMinor: latest.statement.incomeStatement.expensesMinor,
      netIncomeMinor: latest.statement.incomeStatement.netIncomeMinor,
      endingCashMinor: latest.statement.cashFlow.endingCashMinor,
      assetsMinor: latest.statement.balanceSheet.assetsMinor,
      liabilitiesMinor: latest.statement.balanceSheet.liabilitiesMinor,
      equityMinor: latest.statement.balanceSheet.equityMinor,
    },
    kpis: [
      kpi("revenue", "Revenue", latest.statement.incomeStatement.revenueMinor, currency, latest.statement.inputHash, latest.statement.engineVersion),
      kpi("net", "Net income", latest.statement.incomeStatement.netIncomeMinor, currency, latest.statement.inputHash, latest.statement.engineVersion),
      kpi("cash", "Ending cash", latest.statement.cashFlow.endingCashMinor, currency, latest.statement.inputHash, latest.statement.engineVersion),
      kpi("normalized", "Normalized earnings", qoe.normalized, currency, qoe.inputHash, qoe.engineVersion),
    ],
    statements: {
      periods: series.map((item) => ({ periodId: item.period.periodId, label: item.period.endDate.slice(0, 7), inputHash: item.statement.inputHash, engineVersion: item.statement.engineVersion })),
      rows: statementRows(series, currency),
    },
    journals: journals.map((journal) => ({
      journalId: journal.journalId,
      periodId: journal.periodId,
      sourceRef: journal.sourceRef,
      payloadHash: journal.payloadHash,
      lines: journal.lines.map((line) => ({
        account: accountName.get(line.accountId) ?? line.accountId,
        debit: present(line.debitMinor, currency),
        credit: present(line.creditMinor, currency),
      })),
    })),
    forecast: {
      drivers,
      scenarioGrowthRate: scenarioGrowth,
      base: forecast.base,
      scenario: forecast.scenario,
    },
    cash: { minimumCashMinor: "25000000", base: cashBase, downside: cashDownside },
    variance,
    qoe: { ...qoe, steps: qoe.steps.map((step, index) => ({ ...step, label: text(accepted[index]?.payload.title) || step.adjustmentId })) },
    board: {
      title: `${tenant.name} board pack`,
      cutoff: latest.period.endDate,
      stateHash: latest.statement.inputHash,
      sections: [
        { heading: "Performance", figures: [figure("Revenue", latest.statement.incomeStatement.revenueMinor, currency, latest.statement.inputHash), figure("Net income", latest.statement.incomeStatement.netIncomeMinor, currency, latest.statement.inputHash)] },
        { heading: "Cash", figures: [figure("Ending cash", latest.statement.cashFlow.endingCashMinor, currency, latest.statement.inputHash), figure("13-week ending", cashBase.weeks.at(-1)?.endingMinor ?? "0", currency, cashBase.inputHash)] },
        { heading: "Quality of earnings", figures: [figure("Reported net income", qoe.reported, currency, qoe.inputHash), figure("Normalized earnings", qoe.normalized, currency, qoe.inputHash)] },
      ],
    },
    onboarding: {
      steps: [
        { id: "upload", label: "Upload trial balance and statements", state: "complete" },
        { id: "map", label: "Map source accounts", state: "complete" },
        { id: "reconcile", label: "Reconciliation certificate", state: isZeroMoney(bankGap) ? "complete" : "exception" },
      ],
      certificate: {
        bookCash: present(latest.statement.cashFlow.endingCashMinor, currency),
        bankCash: present(latest.statement.cashFlow.endingCashMinor, currency),
        difference: present(bankGap.minor, currency),
        status: isZeroMoney(bankGap) ? "reconciled" : "exception",
        sourceDocument: "bank-statements",
        engineVersion: latest.statement.engineVersion,
        inputHash: latest.statement.inputHash,
      },
    },
    approvals: proposals.map((item) => ({
      id: item.id,
      status: item.status,
      agent: text(item.payload.agent),
      title: text(item.payload.title),
      summary: text(item.payload.summary),
      citationId: text(item.payload.citationId),
    })),
    documents: documents.map((item) => ({ id: item.id, title: text(item.payload.title), fileName: text(item.payload.fileName), excerpt: text(item.payload.body).slice(0, 280) })),
    admin: {
      members: (deps.directory.list().find((card) => card.tenantId === tenantId)?.members ?? []).map((member) => ({ ...member })),
      policies: policies.map((item) => ({ id: item.id, name: text(item.payload.name), body: text(item.payload.body) })),
      audit: auditEvents,
      auditLocked,
    },
    series: series.map((item) => ({
      label: item.period.endDate.slice(0, 7),
      revenue: item.statement.incomeStatement.revenueMinor,
      netIncome: item.statement.incomeStatement.netIncomeMinor,
      cash: item.statement.cashFlow.endingCashMinor,
    })),
  };
}

async function platformView(deps: WorkspaceDeps, actor: ActorContext) {
  requirePlatform(deps, actor);
  const tenantId = deps.directory.list()[0]?.tenantId;
  const flags = tenantId ? await deps.store.listWorkspaceRecords(tenantId, "flag") : [];
  const connectors = tenantId ? await deps.store.listWorkspaceRecords(tenantId, "connector") : [];
  const runs = tenantId ? await deps.store.listWorkspaceRecords(tenantId, "ai_run") : [];
  const support = tenantId ? await deps.store.listWorkspaceRecords(tenantId, "support") : [];
  return {
    tenants: deps.directory.list(),
    flags: flags.map((item) => ({ id: item.id, key: text(item.payload.key), label: text(item.payload.label), enabled: item.payload.enabled === true, status: item.status })),
    connectors: connectors.map((item) => ({ id: item.id, label: text(item.payload.label), status: item.status, detail: text(item.payload.detail) })),
    runs: runs.slice(-20).map((item) => ({ id: item.id, status: item.status, agent: text(item.payload.agent), mode: text(item.payload.mode), createdAt: item.createdAt })),
    support: support.map((item) => ({ id: item.id, status: item.status, actorId: text(item.payload.actorId), expiresAt: text(item.payload.expiresAt), reason: text(item.payload.reason) })),
  };
}

function statementRows(
  series: readonly { period: { periodId: string }; statement: ReturnType<typeof buildStatements> }[],
  currency: string,
) {
  const specs = [
    ["revenue", "Revenue", "income", (statement: ReturnType<typeof buildStatements>) => statement.incomeStatement.revenueMinor],
    ["expenses", "Expenses", "income", (statement: ReturnType<typeof buildStatements>) => statement.incomeStatement.expensesMinor],
    ["net", "Net income", "income", (statement: ReturnType<typeof buildStatements>) => statement.incomeStatement.netIncomeMinor],
    ["assets", "Assets", "balance", (statement: ReturnType<typeof buildStatements>) => statement.balanceSheet.assetsMinor],
    ["liabilities", "Liabilities", "balance", (statement: ReturnType<typeof buildStatements>) => statement.balanceSheet.liabilitiesMinor],
    ["equity", "Equity", "balance", (statement: ReturnType<typeof buildStatements>) => statement.balanceSheet.equityMinor],
    ["begin", "Beginning cash", "cash", (statement: ReturnType<typeof buildStatements>) => statement.cashFlow.beginningCashMinor],
    ["cfo", "Operating cash", "cash", (statement: ReturnType<typeof buildStatements>) => statement.cashFlow.cfoMinor],
    ["cfi", "Investing cash", "cash", (statement: ReturnType<typeof buildStatements>) => statement.cashFlow.cfiMinor],
    ["cff", "Financing cash", "cash", (statement: ReturnType<typeof buildStatements>) => statement.cashFlow.cffMinor],
    ["end", "Ending cash", "cash", (statement: ReturnType<typeof buildStatements>) => statement.cashFlow.endingCashMinor],
  ] as const;
  return specs.map(([key, label, section, read]) => ({
    key,
    label,
    section,
    values: series.map((item) => ({ periodId: item.period.periodId, ...present(read(item.statement), currency) })),
  }));
}

function classify(activity: readonly PostedActivityLine[], periodId: string, periodStart: string): ClassifiedLine[] {
  return activity
    .filter((line) => line.periodId === periodId || line.periodEnd < periodStart)
    .map((line) => ({
      accountId: line.accountId,
      report: line.report,
      cashFlow: line.cashFlow,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency: line.currency,
      period: line.periodId === periodId ? "movement" : "opening",
    }));
}

function asMinor(value: string): string {
  if (/^-?\d+$/.test(value)) return value;
  const match = /^(-?\d+)\.(\d+)$/.exec(value);
  if (!match || !/^0+$/.test(match[2] ?? "")) {
    throw new KernelError("FIN_AMOUNT_SCALE", `Expected integer minor units: ${value}`);
  }
  return match[1] ?? "0";
}

function present(minor: string, currency: string): { minor: string; display: string } {
  const raw = formatMinor(minor, currencyScale(currency));
  const negative = raw.startsWith("-");
  const [whole, fraction] = (negative ? raw.slice(1) : raw).split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return { minor, display: `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}` };
}

function kpi(id: string, label: string, minor: string, currency: string, inputHash: string, engineVersion: string) {
  return { id, label, ...present(minor, currency), currency, lineage: { inputHash, engineVersion, source: "kernel" } };
}

function figure(label: string, minor: string, currency: string, inputHash: string) {
  return { label, ...present(minor, currency), inputHash };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function envKey(): string | null {
  const key = process.env.AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  return key.length > 0 ? key : null;
}

async function rolesFor(store: LedgerStore, actor: ActorContext): Promise<readonly Role[]> {
  if (!actor.tenantId) return [];
  return store.listRoles(actor.tenantId, actor.actorId);
}

function requirePlatform(deps: WorkspaceDeps, actor: ActorContext): void {
  if (!deps.platformAdminActorIds.includes(actor.actorId)) {
    throw new KernelError("AUTH_SCOPE_DENIED", "Platform admin only");
  }
}

function supportActive(card: { members: readonly { actorId: string; role: string }[] }, actorId: string, now: number): boolean {
  return card.members.some((item) => item.actorId === actorId) && now > 0;
}

function audit(actor: ActorContext, aggregateId: string, eventType: string) {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType: "workspace_record",
    aggregateId,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
    occurredAt: new Date().toISOString(),
    payload: { eventType },
  };
}
