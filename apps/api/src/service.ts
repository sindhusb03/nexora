import type { AccountRecord, AuditWrite, JournalRecord, LedgerStore } from "@nexora/db";
import { isUniqueViolation } from "@nexora/db";
import {
  KernelError,
  assertCanonicalClassification,
  assertExpectedVersion,
  assertNoPeriodOverlap,
  assertPeriodOpen,
  assertSameRegion,
  assertTenantActive,
  authorize,
  buildReversalLines,
  ENGINE_VERSION,
  buildStatements,
  currencyScale,
  formatMinor,
  hashMaterial,
  lineToMoneyPair,
  moneyFromDecimal,
  validateJournal,
  valueDcf,
  type Action,
  type Role,
  type StatementSet,
} from "@nexora/kernel";

import { classifyPostedActivity, openingSourceRef } from "./classify-activity.js";
import type { ActorContext } from "./http.js";

export function createLedgerService(store: LedgerStore, platformAdminActorIds: readonly string[]) {
  return {
    provisionTenant: (
      actor: ActorContext,
      input: { name: string; homeRegion: string; ownerActorId: string },
    ) => provisionTenant(store, platformAdminActorIds, actor, input),
    grantMembership: (
      actor: ActorContext,
      input: { actorId: string; role: Exclude<Role, "platform_admin"> },
    ) => grantMembership(store, actor, input),
    createEntity: (
      actor: ActorContext,
      input: {
        legalName: string;
        functionalCurrency: string;
        fiscalYearEndMonth?: number | undefined;
        fiscalYearEndDay?: number | undefined;
      },
    ) => createEntity(store, actor, input),
    listEntities: (actor: ActorContext) => listEntities(store, actor),
    createAccount: (
      actor: ActorContext,
      input: {
        entityId: string;
        code: string;
        name: string;
        report: AccountRecord["report"];
        cashFlow: AccountRecord["cashFlow"];
        retainedEarnings: boolean;
      },
    ) => createAccount(store, actor, input),
    listAccounts: (actor: ActorContext, entityId: string) => listAccounts(store, actor, entityId),
    createPeriod: (
      actor: ActorContext,
      input: { entityId: string; startDate: string; endDate: string },
    ) => createPeriod(store, actor, input),
    listPeriods: (actor: ActorContext, entityId: string) => listPeriods(store, actor, entityId),
    closePeriod: (actor: ActorContext, periodId: string) => closePeriod(store, actor, periodId),
    postJournal: (
      actor: ActorContext,
      input: {
        entityId: string;
        periodId: string;
        currency: string;
        sourceRef?: string | null;
        journalKind?: "opening" | "standard" | undefined;
        lines: readonly { accountId: string; debit: string; credit: string }[];
      },
    ) => postJournal(store, actor, input),
    reverseJournal: (
      actor: ActorContext,
      journalId: string,
      input: { periodId: string; sourceRef?: string | null },
    ) => reverseJournal(store, actor, journalId, input),
    getJournal: (actor: ActorContext, journalId: string) => getJournal(store, actor, journalId),
    listJournals: (actor: ActorContext, entityId: string, periodId: string | null) =>
      listJournals(store, actor, entityId, periodId),
    statements: (actor: ActorContext, entityId: string, periodId: string) =>
      statements(store, actor, entityId, periodId),
    calculateDcf: (
      actor: ActorContext,
      input: {
        currency: string;
        freeCashFlows: readonly string[];
        wacc: string;
        terminalGrowth: string;
        netDebt: string;
        nonOperatingAssets: string;
        otherClaims: string;
      },
    ) => calculateDcf(store, actor, input),
    listAudit: (actor: ActorContext) => listAudit(store, actor),
  };
}

async function provisionTenant(
  store: LedgerStore,
  platformAdminActorIds: readonly string[],
  actor: ActorContext,
  input: { name: string; homeRegion: string; ownerActorId: string },
) {
  requireActor(actor);
  const platformAdmin = platformAdminActorIds.includes(actor.actorId);
  if (platformAdmin) {
    authorize(["platform_admin"], "tenant.provision");
  } else if (input.ownerActorId !== actor.actorId) {
    throw new KernelError("AUTH_SCOPE_DENIED", "A company is opened in your own name");
  } else {
    await requireRegistered(store, actor, actor.actorId);
  }
  assertSameRegion(input.homeRegion, actor.region);
  await requireRegistered(store, actor, input.ownerActorId);
  const now = new Date().toISOString();
  const tenantId = crypto.randomUUID();
  const tenant = await store.createTenant({
    tenant: {
      tenantId,
      name: input.name,
      homeRegion: input.homeRegion,
      status: "active",
      createdAt: now,
    },
    ownerActorId: input.ownerActorId,
    membershipId: crypto.randomUUID(),
    audit: audit(actor, "TenantProvisioned", "tenant", tenantId, now, {
      homeRegion: input.homeRegion,
    }),
  });
  return { tenantId: tenant.tenantId, homeRegion: tenant.homeRegion, name: tenant.name };
}

async function grantMembership(
  store: LedgerStore,
  actor: ActorContext,
  input: { actorId: string; role: Exclude<Role, "platform_admin"> },
) {
  const tenant = await scope(store, actor, "membership.grant");
  await requireRegistered(store, actor, input.actorId);
  const now = new Date().toISOString();
  try {
    await store.grantMembership({
      tenantId: tenant.tenantId,
      membershipId: crypto.randomUUID(),
      actorId: input.actorId,
      role: input.role,
      audit: audit(actor, "MembershipGranted", "membership", tenant.tenantId, now, {
        actorId: input.actorId,
        role: input.role,
      }),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
  return { tenantId: tenant.tenantId, actorId: input.actorId, role: input.role };
}

async function createEntity(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    legalName: string;
    functionalCurrency: string;
    fiscalYearEndMonth?: number | undefined;
    fiscalYearEndDay?: number | undefined;
  },
) {
  const tenant = await scope(store, actor, "entity.write");
  const now = new Date().toISOString();
  const entityId = crypto.randomUUID();
  const entity = await store.createEntity({
    entity: {
      entityId,
      tenantId: tenant.tenantId,
      legalName: input.legalName,
      functionalCurrency: input.functionalCurrency,
      fiscalYearEndMonth: input.fiscalYearEndMonth ?? null,
      fiscalYearEndDay: input.fiscalYearEndDay ?? null,
      retainedEarningsAccountId: null,
    },
    audit: audit(actor, "EntityCreated", "legal_entity", entityId, now, {
      functionalCurrency: input.functionalCurrency,
    }),
  });
  return {
    entityId: entity.entityId,
    legalName: entity.legalName,
    functionalCurrency: entity.functionalCurrency,
  };
}

async function listEntities(store: LedgerStore, actor: ActorContext) {
  const tenant = await scope(store, actor, "statement.read");
  const entities = await store.listEntities(tenant.tenantId);
  return {
    entities: entities.map((entity) => ({
      entityId: entity.entityId,
      legalName: entity.legalName,
      functionalCurrency: entity.functionalCurrency,
      retainedEarningsAccountId: entity.retainedEarningsAccountId,
    })),
  };
}

async function listAccounts(store: LedgerStore, actor: ActorContext, entityId: string) {
  const tenant = await scope(store, actor, "statement.read");
  const entity = await requiredEntity(store, tenant.tenantId, entityId);
  const accounts = await store.listAccounts(tenant.tenantId, entity.entityId);
  return {
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      code: account.code,
      name: account.name,
      report: account.report,
      cashFlow: account.cashFlow,
      currency: account.currency,
      active: account.active,
      retainedEarnings: account.accountId === entity.retainedEarningsAccountId,
    })),
  };
}

async function createAccount(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    entityId: string;
    code: string;
    name: string;
    report: AccountRecord["report"];
    cashFlow: AccountRecord["cashFlow"];
    retainedEarnings: boolean;
  },
) {
  const tenant = await scope(store, actor, "account.write");
  const entity = await requiredEntity(store, tenant.tenantId, input.entityId);
  if (input.retainedEarnings && input.report !== "equity") {
    throw new KernelError(
      "FIN_INVALID_JOURNAL_LINE",
      "Retained earnings must be an equity account",
    );
  }
  assertCanonicalClassification({
    code: input.code,
    report: input.report,
    cashFlow: input.cashFlow,
  });
  const now = new Date().toISOString();
  const accountId = crypto.randomUUID();
  const created = await store.createAccount({
    account: {
      accountId,
      tenantId: tenant.tenantId,
      entityId: entity.entityId,
      code: input.code,
      name: input.name,
      report: input.report,
      cashFlow: input.cashFlow,
      currency: entity.functionalCurrency,
      active: true,
    },
    retainedEarnings: input.retainedEarnings,
    audit: audit(actor, "AccountCreated", "account", accountId, now, {
      code: input.code,
      currency: entity.functionalCurrency,
    }),
  });
  return {
    accountId: created.accountId,
    code: created.code,
    currency: created.currency,
    retainedEarnings: input.retainedEarnings,
  };
}

async function createPeriod(
  store: LedgerStore,
  actor: ActorContext,
  input: { entityId: string; startDate: string; endDate: string },
) {
  const tenant = await scope(store, actor, "period.write");
  await requiredEntity(store, tenant.tenantId, input.entityId);
  const existing = await store.listPeriods(tenant.tenantId, input.entityId);
  assertNoPeriodOverlap(input, existing);
  const now = new Date().toISOString();
  const periodId = crypto.randomUUID();
  const period = await store.createPeriod({
    period: {
      periodId,
      tenantId: tenant.tenantId,
      entityId: input.entityId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: "open",
    },
    audit: audit(actor, "PeriodOpened", "accounting_period", periodId, now, {
      startDate: input.startDate,
      endDate: input.endDate,
    }),
  });
  return {
    periodId: period.periodId,
    status: period.status,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}

async function listPeriods(store: LedgerStore, actor: ActorContext, entityId: string) {
  const tenant = await scope(store, actor, "statement.read");
  const entity = await requiredEntity(store, tenant.tenantId, entityId);
  const periods = await store.listPeriods(tenant.tenantId, entity.entityId);
  return {
    periods: periods.map((period) => ({
      periodId: period.periodId,
      startDate: period.startDate,
      endDate: period.endDate,
      status: period.status,
    })),
  };
}

async function closePeriod(store: LedgerStore, actor: ActorContext, periodId: string) {
  const tenant = await scope(store, actor, "period.close");
  const period = await requiredPeriod(store, tenant.tenantId, periodId);
  assertPeriodOpen(period.status);
  const now = new Date().toISOString();
  const closed = await store.closePeriod({
    tenantId: tenant.tenantId,
    periodId,
    audit: audit(actor, "PeriodClosed", "accounting_period", periodId, now, { status: "closed" }),
  });
  return { periodId: closed.periodId, status: closed.status };
}

async function postJournal(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    entityId: string;
    periodId: string;
    currency: string;
    sourceRef?: string | null;
    journalKind?: "opening" | "standard" | undefined;
    lines: readonly { accountId: string; debit: string; credit: string }[];
  },
) {
  const tenant = await scope(store, actor, "journal.post");
  if (!actor.idempotencyKey) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Idempotency-Key is required");
  }
  const entity = await requiredEntity(store, tenant.tenantId, input.entityId);
  if (input.currency !== entity.functionalCurrency) {
    throw new KernelError(
      "FIN_CURRENCY_MISMATCH",
      "Journal currency must match the entity functional currency",
    );
  }
  const period = await requiredPeriod(store, tenant.tenantId, input.periodId);
  if (period.entityId !== entity.entityId) {
    throw new KernelError("FIN_NOT_FOUND", "Period does not belong to the entity");
  }
  assertPeriodOpen(period.status);
  const accounts = await accountsById(store, tenant.tenantId, entity.entityId);
  const balanced = validateJournal({
    currency: input.currency,
    entityId: entity.entityId,
    periodId: period.periodId,
    lines: input.lines.map((line) => {
      const account = accounts.get(line.accountId);
      if (!account || !account.active) {
        throw new KernelError("FIN_NOT_FOUND", "Account is not available for posting");
      }
      if (account.currency !== input.currency) {
        throw new KernelError(
          "FIN_CURRENCY_MISMATCH",
          "Account currency does not match the journal",
        );
      }
      return {
        accountId: line.accountId,
        debit: moneyFromDecimal(input.currency, line.debit),
        credit: moneyFromDecimal(input.currency, line.credit),
      };
    }),
  });

  const existing = await store.findJournalByIdempotency(tenant.tenantId, actor.idempotencyKey);
  if (existing) {
    if (existing.payloadHash !== balanced.payloadHash) {
      throw new KernelError(
        "FIN_IDEMPOTENCY_MISMATCH",
        "Idempotency key was reused with a different payload",
      );
    }
    return presentJournal(existing, true);
  }

  const now = new Date().toISOString();
  const journalId = crypto.randomUUID();
  try {
    const stored = await store.insertPostedJournal({
      journal: {
        journalId,
        tenantId: tenant.tenantId,
        entityId: entity.entityId,
        periodId: period.periodId,
        currency: balanced.currency,
        idempotencyKey: actor.idempotencyKey,
        payloadHash: balanced.payloadHash,
        reversesJournalId: null,
        sourceRef:
          input.journalKind === "opening"
            ? openingSourceRef(input.sourceRef)
            : (input.sourceRef ?? null),
        actorId: actor.actorId,
        correlationId: actor.correlationId,
        version: 1,
        postedAt: now,
      },
      lines: balanced.lines.map((line, index) => ({
        lineId: crypto.randomUUID(),
        accountId: line.accountId,
        lineNo: index + 1,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      })),
      domainEventId: crypto.randomUUID(),
      audit: audit(actor, "JournalPosted", "journal", journalId, now, {
        payloadHash: balanced.payloadHash,
        totalDebitMinor: balanced.totalDebitMinor,
        currency: balanced.currency,
      }),
    });
    return presentJournal(stored, false);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await store.findJournalByIdempotency(tenant.tenantId, actor.idempotencyKey);
    if (!raced || raced.payloadHash !== balanced.payloadHash) {
      throw new KernelError(
        "FIN_IDEMPOTENCY_MISMATCH",
        "Idempotency key was reused with a different payload",
      );
    }
    return presentJournal(raced, true);
  }
}

async function reverseJournal(
  store: LedgerStore,
  actor: ActorContext,
  journalId: string,
  input: { periodId: string; sourceRef?: string | null },
) {
  const tenant = await scope(store, actor, "journal.reverse");
  if (!actor.idempotencyKey) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Idempotency-Key is required");
  }
  if (actor.expectedVersion === null) {
    throw new KernelError(
      "FIN_VERSION_CONFLICT",
      "Expected-Version is required to reverse a journal",
    );
  }
  const original = await store.getJournal(tenant.tenantId, journalId);
  if (!original) {
    throw new KernelError("FIN_NOT_FOUND", "Journal not found");
  }
  assertExpectedVersion(original.version, actor.expectedVersion);
  const prior = await store.findReversal(tenant.tenantId, original.journalId);
  if (prior) {
    throw new KernelError("FIN_IMMUTABLE_RECORD", "Posted journal already has a reversal");
  }
  const period = await requiredPeriod(store, tenant.tenantId, input.periodId);
  if (period.entityId !== original.entityId) {
    throw new KernelError("FIN_NOT_FOUND", "Period does not belong to the entity");
  }
  assertPeriodOpen(period.status);
  const reversalLines = buildReversalLines(
    original.lines.map((line) => ({
      accountId: line.accountId,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency: original.currency,
    })),
  );
  const balanced = validateJournal({
    currency: original.currency,
    entityId: original.entityId,
    periodId: period.periodId,
    lines: reversalLines.map((line) => {
      const pair = lineToMoneyPair(line);
      return { accountId: line.accountId, debit: pair.debit, credit: pair.credit };
    }),
  });
  const now = new Date().toISOString();
  const reversalId = crypto.randomUUID();
  const stored = await store.insertPostedJournal({
    journal: {
      journalId: reversalId,
      tenantId: tenant.tenantId,
      entityId: original.entityId,
      periodId: period.periodId,
      currency: balanced.currency,
      idempotencyKey: actor.idempotencyKey,
      payloadHash: balanced.payloadHash,
      reversesJournalId: original.journalId,
      sourceRef: input.sourceRef ?? null,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      version: 1,
      postedAt: now,
    },
    lines: balanced.lines.map((line, index) => ({
      lineId: crypto.randomUUID(),
      accountId: line.accountId,
      lineNo: index + 1,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
    })),
    domainEventId: crypto.randomUUID(),
    audit: audit(actor, "JournalReversed", "journal", reversalId, now, {
      reversesJournalId: original.journalId,
      payloadHash: balanced.payloadHash,
      totalDebitMinor: balanced.totalDebitMinor,
    }),
  });
  return presentJournal(stored, false);
}

async function getJournal(store: LedgerStore, actor: ActorContext, journalId: string) {
  const tenant = await scope(store, actor, "journal.read");
  const journal = await store.getJournal(tenant.tenantId, journalId);
  if (!journal) {
    throw new KernelError("FIN_NOT_FOUND", "Journal not found");
  }
  return presentJournal(journal, false);
}

async function listJournals(
  store: LedgerStore,
  actor: ActorContext,
  entityId: string,
  periodId: string | null,
) {
  const tenant = await scope(store, actor, "journal.read");
  const entity = await requiredEntity(store, tenant.tenantId, entityId);
  if (periodId) {
    const period = await requiredPeriod(store, tenant.tenantId, periodId);
    if (period.entityId !== entity.entityId) {
      throw new KernelError("FIN_NOT_FOUND", "Period does not belong to the entity");
    }
  }
  const journals = await store.listJournals(tenant.tenantId, entity.entityId, periodId);
  return { journals: journals.map((journal) => presentJournal(journal, false)) };
}

async function statements(
  store: LedgerStore,
  actor: ActorContext,
  entityId: string,
  periodId: string,
) {
  const tenant = await scope(store, actor, "statement.read");
  const { statement } = await computeStatementsForPeriod(
    store,
    tenant.tenantId,
    entityId,
    periodId,
  );
  return presentStatement(statement);
}

/**
 * Posted activity through the period end, classified the same way as the statements.
 * Earlier periods are opening. The selected period is movement. Callers authorize first.
 */
export async function loadClassifiedActivity(
  store: LedgerStore,
  tenantId: string,
  entityId: string,
  periodId: string,
) {
  const entity = await requiredEntity(store, tenantId, entityId);
  if (!entity.retainedEarningsAccountId) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Entity has no retained earnings account");
  }
  const period = await requiredPeriod(store, tenantId, periodId);
  if (period.entityId !== entity.entityId) {
    throw new KernelError("FIN_NOT_FOUND", "Period does not belong to the entity");
  }
  const activity = await store.listPostedActivity(tenantId, entity.entityId);
  const lines = classifyPostedActivity(
    activity.filter((line) => line.periodStart <= period.endDate),
    period,
  );
  return {
    currency: entity.functionalCurrency,
    retainedEarningsAccountId: entity.retainedEarningsAccountId,
    periodStart: period.startDate,
    periodEnd: period.endDate,
    lines,
  };
}

/** Internal kernel path. Callers authorize the operation before passing their tenant scope. */
export async function computeStatementsForPeriod(
  store: LedgerStore,
  tenantId: string,
  entityId: string,
  periodId: string,
) {
  const inputs = await loadClassifiedActivity(store, tenantId, entityId, periodId);
  return { statement: buildStatements(inputs), inputs };
}

async function calculateDcf(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    currency: string;
    freeCashFlows: readonly string[];
    wacc: string;
    terminalGrowth: string;
    netDebt: string;
    nonOperatingAssets: string;
    otherClaims: string;
  },
) {
  const tenant = await scope(store, actor, "valuation.calculate");
  const now = new Date().toISOString();
  const calculationRunId = crypto.randomUUID();
  const inputHash = hashMaterial({ ...input, convention: "year_end_gordon_growth" });
  try {
    const result = valueDcf({
      currency: input.currency,
      freeCashFlows: input.freeCashFlows,
      wacc: input.wacc,
      terminalGrowth: input.terminalGrowth,
      netDebt: input.netDebt,
      nonOperatingAssets: input.nonOperatingAssets,
      otherClaims: input.otherClaims,
    });
    await store.insertCalculationRun({
      run: {
        calculationRunId,
        tenantId: tenant.tenantId,
        kind: "dcf",
        status: "succeeded",
        engineVersion: result.engineVersion,
        inputHash: result.inputHash,
        inputs: { ...input },
        outputs: {
          enterpriseValue: result.enterpriseValue,
          equityValue: result.equityValue,
          terminalValue: result.terminalValue,
        },
        actorId: actor.actorId,
        correlationId: actor.correlationId,
        createdAt: now,
      },
      audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
        inputHash: result.inputHash,
        engineVersion: result.engineVersion,
        status: "succeeded",
      }),
    });
    return { calculationRunId, ...result };
  } catch (error) {
    if (error instanceof KernelError) {
      await store.insertCalculationRun({
        run: {
          calculationRunId,
          tenantId: tenant.tenantId,
          kind: "dcf",
          status: "failed",
          engineVersion: ENGINE_VERSION,
          inputHash,
          inputs: { ...input },
          outputs: null,
          actorId: actor.actorId,
          correlationId: actor.correlationId,
          createdAt: now,
        },
        audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
          status: "failed",
          code: error.code,
        }),
      });
    }
    throw error;
  }
}

async function listAudit(store: LedgerStore, actor: ActorContext) {
  const tenant = await scope(store, actor, "audit.read");
  const events = await store.listAudit(tenant.tenantId);
  return {
    events: events.map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      actorId: event.actorId,
      correlationId: event.correlationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
    })),
  };
}

async function scope(store: LedgerStore, actor: ActorContext, action: Action) {
  requireActor(actor);
  if (!actor.tenantId) {
    throw new KernelError("AUTH_SCOPE_DENIED", "Tenant scope is required");
  }
  const tenant = await store.getTenant(actor.tenantId);
  if (!tenant) {
    throw new KernelError("FIN_NOT_FOUND", "Tenant not found");
  }
  assertSameRegion(tenant.homeRegion, actor.region);
  assertTenantActive(tenant.status);
  const roles = await store.listRoles(tenant.tenantId, actor.actorId);
  authorize(roles, action);
  return tenant;
}

/**
 * Under signed sessions a membership can only name a registered, enabled user, so a handle
 * cannot be claimed at sign-up after access was granted to it.
 */
async function requireRegistered(
  store: LedgerStore,
  actor: ActorContext,
  targetActorId: string,
): Promise<void> {
  if (!actor.verified) {
    return;
  }
  const user = await store.findUser(targetActorId);
  if (!user || user.disabled) {
    throw new KernelError("FIN_NOT_FOUND", "Actor is not a registered user");
  }
}

function requireActor(actor: ActorContext): void {
  if (actor.actorId.length === 0 || actor.region.length === 0) {
    throw new KernelError("AUTH_SCOPE_DENIED", "Actor and region are required");
  }
}

async function requiredEntity(store: LedgerStore, tenantId: string, entityId: string) {
  const entity = await store.getEntity(tenantId, entityId);
  if (!entity) {
    throw new KernelError("FIN_NOT_FOUND", "Legal entity not found");
  }
  return entity;
}

async function requiredPeriod(store: LedgerStore, tenantId: string, periodId: string) {
  const period = await store.getPeriod(tenantId, periodId);
  if (!period) {
    throw new KernelError("FIN_NOT_FOUND", "Accounting period not found");
  }
  return period;
}

async function accountsById(store: LedgerStore, tenantId: string, entityId: string) {
  const accounts = await store.listAccounts(tenantId, entityId);
  return new Map(accounts.map((account) => [account.accountId, account]));
}

function audit(
  actor: ActorContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): AuditWrite {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType,
    aggregateId,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
    occurredAt,
    payload,
  };
}

function presentJournal(journal: JournalRecord, replayed: boolean) {
  const scale = currencyScale(journal.currency);
  const total = journal.lines.reduce((sum, line) => sum + BigInt(line.debitMinor), 0n).toString();
  return {
    journalId: journal.journalId,
    entityId: journal.entityId,
    periodId: journal.periodId,
    currency: journal.currency,
    version: journal.version,
    payloadHash: journal.payloadHash,
    reversesJournalId: journal.reversesJournalId,
    totalDebitMinor: total,
    totalDebit: formatMinor(total, scale),
    replayed,
    postedAt: journal.postedAt,
    lines: journal.lines.map((line) => ({
      accountId: line.accountId,
      lineNo: line.lineNo,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
    })),
  };
}

function presentStatement(statement: StatementSet) {
  const scale = currencyScale(statement.currency);
  const amount = (minor: string) => ({
    minor,
    amount: formatMinor(minor, scale),
    currency: statement.currency,
  });
  return {
    engineVersion: statement.engineVersion,
    inputHash: statement.inputHash,
    currency: statement.currency,
    incomeStatement: {
      revenue: amount(statement.incomeStatement.revenueMinor),
      expenses: amount(statement.incomeStatement.expensesMinor),
      netIncome: amount(statement.incomeStatement.netIncomeMinor),
    },
    balanceSheet: {
      assets: amount(statement.balanceSheet.assetsMinor),
      liabilities: amount(statement.balanceSheet.liabilitiesMinor),
      equity: amount(statement.balanceSheet.equityMinor),
    },
    cashFlow: {
      beginningCash: amount(statement.cashFlow.beginningCashMinor),
      cfo: amount(statement.cashFlow.cfoMinor),
      cfi: amount(statement.cashFlow.cfiMinor),
      cff: amount(statement.cashFlow.cffMinor),
      endingCash: amount(statement.cashFlow.endingCashMinor),
    },
    retainedEarnings: {
      opening: amount(statement.retainedEarnings.openingMinor),
      netIncome: amount(statement.retainedEarnings.netIncomeMinor),
      distributions: amount(statement.retainedEarnings.distributionsMinor),
      directEntries: amount(statement.retainedEarnings.directEntriesMinor),
      ending: amount(statement.retainedEarnings.endingMinor),
      close: statement.retainedEarnings.close,
    },
  };
}
