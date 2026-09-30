import {
  KernelError,
  ROLES,
  type CashFlowClass,
  type ReportClass,
  type Role,
} from "@nexora/kernel";
import { and, asc, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import type {
  AccountRecord,
  AuditRecord,
  AuditWrite,
  CalculationRunRecord,
  EntityRecord,
  IdentityStore,
  JournalRecord,
  LedgerStore,
  PeriodRecord,
  PostedActivityLine,
  StoredJournalLine,
  TenantRecord,
} from "./records.js";
import { createIdentityStore } from "./identity-store.js";
import { createProgramStore } from "./program-store.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  account,
  accountingPeriod,
  auditEvent,
  calculationRun,
  domainEvent,
  journalEntry,
  journalLine,
  legalEntity,
  membership,
  tenant,
} from "./schema.js";

const REPORTS = ["asset", "liability", "equity", "revenue", "expense"] as const;
const CASH_FLOWS = ["cash", "cfo", "cfi", "cff", "non_cash", "distribution"] as const;

export function createLedgerStore(db: AppDatabase): LedgerStore {
  const core: Omit<
    LedgerStore,
    | keyof ReturnType<typeof createProgramStore>
    | keyof IdentityStore
    | keyof ReturnType<typeof createWorkspaceStore>
  > = {
    createTenant(input) {
      return tenantTx(db, input.tenant.tenantId, async (tx) => {
        await tx.insert(tenant).values({
          tenantId: input.tenant.tenantId,
          name: input.tenant.name,
          homeRegion: input.tenant.homeRegion,
          status: input.tenant.status,
          createdAt: input.tenant.createdAt,
        });
        await tx.insert(membership).values({
          membershipId: input.membershipId,
          tenantId: input.tenant.tenantId,
          actorId: input.ownerActorId,
          role: "owner",
          createdAt: input.tenant.createdAt,
        });
        await writeAudit(tx, input.tenant.tenantId, input.audit);
        return input.tenant;
      });
    },

    grantMembership(input) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(membership).values({
          membershipId: input.membershipId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          role: input.role,
          createdAt: input.audit.occurredAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },

    async getTenant(tenantId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx.select().from(tenant).where(eq(tenant.tenantId, tenantId)).limit(1);
        const row = rows[0];
        if (!row) {
          return null;
        }
        return {
          tenantId: row.tenantId,
          name: row.name,
          homeRegion: row.homeRegion,
          status: row.status === "suspended" ? "suspended" : "active",
          createdAt: row.createdAt,
        } satisfies TenantRecord;
      });
    },

    async listRoles(tenantId, actorId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ role: membership.role })
          .from(membership)
          .where(and(eq(membership.tenantId, tenantId), eq(membership.actorId, actorId)));
        return rows.map((row) => asRole(row.role));
      });
    },

    createEntity(input) {
      return tenantTx(db, input.entity.tenantId, async (tx) => {
        await tx.insert(legalEntity).values({
          legalEntityId: input.entity.entityId,
          tenantId: input.entity.tenantId,
          legalName: input.entity.legalName,
          functionalCurrency: input.entity.functionalCurrency,
          retainedEarningsAccountId: null,
          createdAt: input.audit.occurredAt,
        });
        await writeAudit(tx, input.entity.tenantId, input.audit);
        return input.entity;
      });
    },

    async listEntities(tenantId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx.select().from(legalEntity).where(eq(legalEntity.tenantId, tenantId));
        return rows.map(mapEntity);
      });
    },

    async getEntity(tenantId, entityId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(legalEntity)
          .where(and(eq(legalEntity.tenantId, tenantId), eq(legalEntity.legalEntityId, entityId)))
          .limit(1);
        const row = rows[0];
        if (!row) {
          return null;
        }
        return mapEntity(row);
      });
    },

    createAccount(input) {
      return tenantTx(db, input.account.tenantId, async (tx) => {
        await tx.insert(account).values({
          accountId: input.account.accountId,
          tenantId: input.account.tenantId,
          legalEntityId: input.account.entityId,
          code: input.account.code,
          name: input.account.name,
          report: input.account.report,
          cashFlow: input.account.cashFlow,
          currency: input.account.currency,
          active: input.account.active,
          createdAt: input.audit.occurredAt,
        });
        if (input.retainedEarnings) {
          const updated = await tx
            .update(legalEntity)
            .set({ retainedEarningsAccountId: input.account.accountId })
            .where(
              and(
                eq(legalEntity.tenantId, input.account.tenantId),
                eq(legalEntity.legalEntityId, input.account.entityId),
                isNull(legalEntity.retainedEarningsAccountId),
              ),
            )
            .returning({ id: legalEntity.legalEntityId });
          if (updated.length === 0) {
            throw new KernelError(
              "FIN_IMMUTABLE_RECORD",
              "Retained earnings account is already assigned",
            );
          }
        }
        await writeAudit(tx, input.account.tenantId, input.audit);
        return input.account;
      });
    },

    async listAccounts(tenantId, entityId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(account)
          .where(and(eq(account.tenantId, tenantId), eq(account.legalEntityId, entityId)));
        return rows.map(mapAccount);
      });
    },

    createPeriod(input) {
      return tenantTx(db, input.period.tenantId, async (tx) => {
        await tx.insert(accountingPeriod).values({
          periodId: input.period.periodId,
          tenantId: input.period.tenantId,
          legalEntityId: input.period.entityId,
          startDate: input.period.startDate,
          endDate: input.period.endDate,
          status: input.period.status,
          createdAt: input.audit.occurredAt,
        });
        await writeAudit(tx, input.period.tenantId, input.audit);
        return input.period;
      });
    },

    async getPeriod(tenantId, periodId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(accountingPeriod)
          .where(
            and(eq(accountingPeriod.tenantId, tenantId), eq(accountingPeriod.periodId, periodId)),
          )
          .limit(1);
        const row = rows[0];
        return row ? mapPeriod(row) : null;
      });
    },

    async listPeriods(tenantId, entityId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(accountingPeriod)
          .where(
            and(
              eq(accountingPeriod.tenantId, tenantId),
              eq(accountingPeriod.legalEntityId, entityId),
            ),
          );
        return rows.map(mapPeriod);
      });
    },

    closePeriod(input) {
      return tenantTx(db, input.tenantId, async (tx) => {
        const updated = await tx
          .update(accountingPeriod)
          .set({ status: "closed" })
          .where(
            and(
              eq(accountingPeriod.tenantId, input.tenantId),
              eq(accountingPeriod.periodId, input.periodId),
              eq(accountingPeriod.status, "open"),
            ),
          )
          .returning();
        const row = updated[0];
        if (!row) {
          throw new KernelError("FIN_PERIOD_CLOSED", "Period is missing or already closed");
        }
        await writeAudit(tx, input.tenantId, input.audit);
        return mapPeriod(row);
      });
    },

    findJournalByIdempotency(tenantId, idempotencyKey) {
      return tenantTx(db, tenantId, (tx) =>
        findJournal(tx, tenantId, eq(journalEntry.idempotencyKey, idempotencyKey)),
      );
    },

    findReversal(tenantId, journalId) {
      return tenantTx(db, tenantId, (tx) =>
        findJournal(tx, tenantId, eq(journalEntry.reversesJournalId, journalId)),
      );
    },

    getJournal(tenantId, journalId) {
      return tenantTx(db, tenantId, (tx) =>
        findJournal(tx, tenantId, eq(journalEntry.journalId, journalId)),
      );
    },

    listJournals(tenantId, entityId, periodId) {
      return tenantTx(db, tenantId, async (tx) => {
        const filters = [
          eq(journalEntry.tenantId, tenantId),
          eq(journalEntry.legalEntityId, entityId),
          eq(journalEntry.status, "posted"),
        ];
        if (periodId) {
          filters.push(eq(journalEntry.periodId, periodId));
        }
        const rows = await tx
          .select()
          .from(journalEntry)
          .where(and(...filters))
          .orderBy(asc(journalEntry.postedAt));
        const journals: JournalRecord[] = [];
        for (const row of rows) {
          if (!row.postedAt) {
            continue;
          }
          const lines = await tx
            .select()
            .from(journalLine)
            .where(
              and(eq(journalLine.tenantId, tenantId), eq(journalLine.journalId, row.journalId)),
            )
            .orderBy(asc(journalLine.lineNo));
          journals.push({
            journalId: row.journalId,
            tenantId: row.tenantId,
            entityId: row.legalEntityId,
            periodId: row.periodId,
            currency: row.currency.trim(),
            idempotencyKey: row.idempotencyKey,
            payloadHash: row.payloadHash,
            reversesJournalId: row.reversesJournalId,
            sourceRef: row.sourceRef,
            actorId: row.actorId,
            correlationId: row.correlationId,
            version: row.version,
            postedAt: row.postedAt,
            lines: lines.map((line) => ({
              accountId: line.accountId,
              lineNo: line.lineNo,
              debitMinor: minor(line.debitMinor),
              creditMinor: minor(line.creditMinor),
            })),
          });
        }
        return journals;
      });
    },

    insertPostedJournal(input) {
      return tenantTx(db, input.journal.tenantId, async (tx) => {
        await tx.insert(journalEntry).values({
          journalId: input.journal.journalId,
          tenantId: input.journal.tenantId,
          legalEntityId: input.journal.entityId,
          periodId: input.journal.periodId,
          status: "draft",
          currency: input.journal.currency,
          idempotencyKey: input.journal.idempotencyKey,
          payloadHash: input.journal.payloadHash,
          reversesJournalId: input.journal.reversesJournalId,
          sourceRef: input.journal.sourceRef,
          actorId: input.journal.actorId,
          correlationId: input.journal.correlationId,
          version: input.journal.version,
          createdAt: input.journal.postedAt,
          postedAt: null,
        });
        if (input.lines.length > 0) {
          await tx.insert(journalLine).values(
            input.lines.map((line) => ({
              journalLineId: line.lineId,
              tenantId: input.journal.tenantId,
              journalId: input.journal.journalId,
              accountId: line.accountId,
              lineNo: line.lineNo,
              debitMinor: line.debitMinor,
              creditMinor: line.creditMinor,
            })),
          );
        }
        await tx
          .update(journalEntry)
          .set({ status: "posted", postedAt: input.journal.postedAt })
          .where(
            and(
              eq(journalEntry.tenantId, input.journal.tenantId),
              eq(journalEntry.journalId, input.journal.journalId),
            ),
          );
        await writeAudit(tx, input.journal.tenantId, input.audit);
        await tx.insert(domainEvent).values({
          eventId: input.domainEventId,
          eventType: "JournalPosted",
          eventVersion: 1,
          tenantId: input.journal.tenantId,
          occurredAt: input.audit.occurredAt,
          actorId: input.audit.actorId,
          correlationId: input.audit.correlationId,
          causationId: input.audit.eventId,
          aggregateType: "journal",
          aggregateId: input.journal.journalId,
          payload: input.audit.payload,
        });
        const stored = await findJournal(
          tx,
          input.journal.tenantId,
          eq(journalEntry.journalId, input.journal.journalId),
        );
        if (!stored) {
          throw new KernelError("TENANT_ISOLATION", "Posted journal was not visible to its tenant");
        }
        return stored;
      });
    },

    async listPostedActivity(tenantId, entityId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            accountId: journalLine.accountId,
            report: account.report,
            cashFlow: account.cashFlow,
            currency: journalEntry.currency,
            debitMinor: journalLine.debitMinor,
            creditMinor: journalLine.creditMinor,
            periodId: journalEntry.periodId,
            periodEnd: accountingPeriod.endDate,
          })
          .from(journalLine)
          .innerJoin(journalEntry, eq(journalLine.journalId, journalEntry.journalId))
          .innerJoin(account, eq(journalLine.accountId, account.accountId))
          .innerJoin(accountingPeriod, eq(journalEntry.periodId, accountingPeriod.periodId))
          .where(
            and(
              eq(journalEntry.tenantId, tenantId),
              eq(journalLine.tenantId, tenantId),
              eq(journalEntry.legalEntityId, entityId),
              eq(journalEntry.status, "posted"),
            ),
          );
        return rows.map((row) => ({
          accountId: row.accountId,
          report: asReport(row.report),
          cashFlow: asCashFlow(row.cashFlow),
          currency: row.currency.trim(),
          debitMinor: minor(row.debitMinor),
          creditMinor: minor(row.creditMinor),
          periodId: row.periodId,
          periodEnd: row.periodEnd,
        })) satisfies PostedActivityLine[];
      });
    },

    async listAudit(tenantId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(auditEvent)
          .where(eq(auditEvent.tenantId, tenantId))
          .orderBy(asc(auditEvent.occurredAt));
        return rows.map((row) => ({
          eventId: row.eventId,
          eventType: row.eventType,
          tenantId: row.tenantId,
          occurredAt: row.occurredAt,
          actorId: row.actorId,
          correlationId: row.correlationId,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          payload: row.payload,
        })) satisfies AuditRecord[];
      });
    },

    insertCalculationRun(input) {
      return tenantTx(db, input.run.tenantId, async (tx) => {
        await tx.insert(calculationRun).values({
          calculationRunId: input.run.calculationRunId,
          tenantId: input.run.tenantId,
          kind: input.run.kind,
          status: input.run.status,
          engineVersion: input.run.engineVersion,
          inputHash: input.run.inputHash,
          inputs: input.run.inputs,
          outputs: input.run.outputs,
          actorId: input.run.actorId,
          correlationId: input.run.correlationId,
          createdAt: input.run.createdAt,
        });
        await writeAudit(tx, input.run.tenantId, input.audit);
        return input.run;
      });
    },

    async getCalculationRun(tenantId, calculationRunId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(calculationRun)
          .where(
            and(
              eq(calculationRun.tenantId, tenantId),
              eq(calculationRun.calculationRunId, calculationRunId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) {
          return null;
        }
        return {
          calculationRunId: row.calculationRunId,
          tenantId: row.tenantId,
          kind: row.kind,
          status: row.status === "failed" ? "failed" : "succeeded",
          engineVersion: row.engineVersion,
          inputHash: row.inputHash,
          inputs: row.inputs,
          outputs: row.outputs,
          actorId: row.actorId,
          correlationId: row.correlationId,
          createdAt: row.createdAt,
        } satisfies CalculationRunRecord;
      });
    },
  };
  return {
    ...core,
    ...createProgramStore(db),
    ...createIdentityStore(db),
    ...createWorkspaceStore(db),
  };
}

export async function tenantTx<T>(
  db: AppDatabase,
  tenantId: string,
  fn: (tx: AppDatabase) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE nexora_app"));
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx as unknown as AppDatabase);
    });
  } catch (error) {
    rethrowDomain(error);
  }
}

export async function writeAudit(
  tx: AppDatabase,
  tenantId: string,
  audit: AuditWrite,
): Promise<void> {
  await tx.insert(auditEvent).values({
    eventId: audit.eventId,
    eventType: audit.eventType,
    eventVersion: 1,
    tenantId,
    occurredAt: audit.occurredAt,
    actorId: audit.actorId,
    correlationId: audit.correlationId,
    causationId: null,
    aggregateType: audit.aggregateType,
    aggregateId: audit.aggregateId,
    payload: audit.payload,
  });
}

async function findJournal(
  tx: AppDatabase,
  tenantId: string,
  predicate: ReturnType<typeof eq>,
): Promise<JournalRecord | null> {
  const rows = await tx
    .select()
    .from(journalEntry)
    .where(and(eq(journalEntry.tenantId, tenantId), eq(journalEntry.status, "posted"), predicate))
    .limit(1);
  const row = rows[0];
  if (!row || !row.postedAt) {
    return null;
  }
  const lines = await tx
    .select()
    .from(journalLine)
    .where(and(eq(journalLine.tenantId, tenantId), eq(journalLine.journalId, row.journalId)))
    .orderBy(asc(journalLine.lineNo));
  return {
    journalId: row.journalId,
    tenantId: row.tenantId,
    entityId: row.legalEntityId,
    periodId: row.periodId,
    currency: row.currency.trim(),
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    reversesJournalId: row.reversesJournalId,
    sourceRef: row.sourceRef,
    actorId: row.actorId,
    correlationId: row.correlationId,
    version: row.version,
    postedAt: row.postedAt,
    lines: lines.map((line): StoredJournalLine => ({
      accountId: line.accountId,
      lineNo: line.lineNo,
      debitMinor: minor(line.debitMinor),
      creditMinor: minor(line.creditMinor),
    })),
  };
}

function mapEntity(row: typeof legalEntity.$inferSelect): EntityRecord {
  return {
    entityId: row.legalEntityId,
    tenantId: row.tenantId,
    legalName: row.legalName,
    functionalCurrency: row.functionalCurrency.trim(),
    retainedEarningsAccountId: row.retainedEarningsAccountId,
  };
}

function mapAccount(row: typeof account.$inferSelect): AccountRecord {
  return {
    accountId: row.accountId,
    tenantId: row.tenantId,
    entityId: row.legalEntityId,
    code: row.code,
    name: row.name,
    report: asReport(row.report),
    cashFlow: asCashFlow(row.cashFlow),
    currency: row.currency.trim(),
    active: row.active,
  };
}

function mapPeriod(row: typeof accountingPeriod.$inferSelect): PeriodRecord {
  return {
    periodId: row.periodId,
    tenantId: row.tenantId,
    entityId: row.legalEntityId,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status === "closed" ? "closed" : "open",
  };
}

function asRole(value: string): Role {
  if (value === "platform_admin" || !ROLES.includes(value as Role)) {
    throw new KernelError("AUTH_SCOPE_DENIED", "Membership role is not recognized");
  }
  return value as Role;
}

function asReport(value: string): ReportClass {
  if (!REPORTS.includes(value as ReportClass)) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", `Unknown account report class ${value}`);
  }
  return value as ReportClass;
}

function asCashFlow(value: string): CashFlowClass {
  if (!CASH_FLOWS.includes(value as CashFlowClass)) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", `Unknown cash flow class ${value}`);
  }
  return value as CashFlowClass;
}

function minor(value: string): string {
  return BigInt(value).toString();
}

function rethrowDomain(error: unknown): never {
  if (error instanceof KernelError) {
    throw error;
  }
  const message = errorText(error);
  if (message.includes("FIN_IMMUTABLE_RECORD")) {
    throw new KernelError("FIN_IMMUTABLE_RECORD", "Posted financial records are immutable");
  }
  if (message.includes("FIN_UNBALANCED_JOURNAL")) {
    throw new KernelError("FIN_UNBALANCED_JOURNAL", "Debit/credit invariant failed");
  }
  if (message.includes("FIN_PERIOD_CLOSED")) {
    throw new KernelError("FIN_PERIOD_CLOSED", "Closed periods cannot be changed");
  }
  if (message.includes("TENANT_ISOLATION")) {
    throw new KernelError("TENANT_ISOLATION", "Tenant boundary rejected the write");
  }
  throw error instanceof Error ? error : new Error(message);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? errorText(error.cause) : "";
    return `${error.message} ${cause}`;
  }
  return String(error);
}

export function isUniqueViolation(error: unknown): boolean {
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "object" && current !== null) {
      if ("code" in current && current.code === "23505") {
        return true;
      }
      if ("cause" in current) {
        queue.push(current.cause);
      }
    }
  }
  return false;
}
