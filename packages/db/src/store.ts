import {
  KernelError,
  assertNoPeriodOverlap,
  assertPeriodOpen,
  assertPeriodRange,
  ROLES,
  buildStatements,
  type CashFlowClass,
  type ClassifiedLine,
  type ReportClass,
  type Role,
} from "@nexora/kernel";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import type {
  AccountRecord,
  AuditRecord,
  AuditWrite,
  ActorCompany,
  CalculationRunRecord,
  EntityRecord,
  IdentityStore,
  IngestionPostCommit,
  JournalRecord,
  LedgerPostSnapshot,
  LedgerStore,
  PeriodRecord,
  PostedActivityLine,
  StoredJournalLine,
  TenantRecord,
} from "./records.js";
import { writeRoleChangeAudit } from "./auth-store.js";
import { ingestionJob } from "./ingestion-schema.js";
import { createIngestionStore } from "./ingestion-store.js";
import { lineageEdge } from "./program-schema.js";
import { createIdentityStore } from "./identity-store.js";
import { currentRlsSession } from "./session-context.js";
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
    | keyof ReturnType<typeof createIngestionStore>
  > = {
    createTenant(input) {
      return provisionOwnedTenant(db, input);
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
        await writeRoleChangeAudit(tx, {
          actorId: input.actorId,
          tenantId: input.tenantId,
          role: input.role,
          grantedBy: input.audit.actorId,
          requestId: input.audit.correlationId,
          occurredAt: input.audit.occurredAt,
        });
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
          .where(
            and(
              eq(membership.tenantId, tenantId),
              eq(membership.actorId, actorId),
              eq(membership.status, "active"),
            ),
          );
        return rows.map((row) => asRole(row.role));
      });
    },

    async listActorCompanies(actorId) {
      const visible = await actorTx(db, actorId, async (tx) => {
        const rows = await tx
          .select({
            tenantId: tenant.tenantId,
            name: tenant.name,
            homeRegion: tenant.homeRegion,
            status: tenant.status,
          })
          .from(membership)
          .innerJoin(tenant, eq(membership.tenantId, tenant.tenantId))
          .where(and(eq(membership.actorId, actorId), eq(membership.status, "active")));
        const byTenant = new Map<string, (typeof rows)[number]>();
        for (const row of rows) byTenant.set(row.tenantId, row);
        return [...byTenant.values()];
      });
      const companies: ActorCompany[] = [];
      for (const row of visible) {
        const detail = await tenantTx(db, row.tenantId, async (tx) =>
          companyDetail(tx, row.tenantId),
        );
        companies.push({
          tenantId: row.tenantId,
          name: row.name,
          homeRegion: row.homeRegion,
          status: row.status === "suspended" ? "suspended" : "active",
          entityId: detail.entityId,
          periodId: detail.periodId,
          members: detail.members,
        });
      }
      companies.sort((left, right) => left.name.localeCompare(right.name));
      return companies;
    },

    async listMemberships(tenantId) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ actorId: membership.actorId, role: membership.role })
          .from(membership)
          .where(and(eq(membership.tenantId, tenantId), eq(membership.status, "active")))
          .orderBy(asc(membership.actorId), asc(membership.role));
        return rows;
      });
    },

    createEntity(input) {
      return tenantTx(db, input.entity.tenantId, async (tx) => {
        await tx.insert(legalEntity).values({
          legalEntityId: input.entity.entityId,
          tenantId: input.entity.tenantId,
          legalName: input.entity.legalName,
          functionalCurrency: input.entity.functionalCurrency,
          fiscalYearEndMonth: input.entity.fiscalYearEndMonth,
          fiscalYearEndDay: input.entity.fiscalYearEndDay,
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
        await lockEntity(tx, input.period.tenantId, input.period.entityId);
        const existing = await tx
          .select()
          .from(accountingPeriod)
          .where(
            and(
              eq(accountingPeriod.tenantId, input.period.tenantId),
              eq(accountingPeriod.legalEntityId, input.period.entityId),
            ),
          );
        assertNoPeriodOverlap(input.period, existing);
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
        // Read the immutable entity reference first; acquire locks entity then period everywhere.
        const [target] = await tx
          .select()
          .from(accountingPeriod)
          .where(
            and(
              eq(accountingPeriod.tenantId, input.tenantId),
              eq(accountingPeriod.periodId, input.periodId),
            ),
          );
        if (!target) throw new KernelError("FIN_INVALID_PERIOD", "Accounting period not found");
        await lockEntity(tx, input.tenantId, target.legalEntityId);
        await lockPeriod(tx, input.tenantId, input.periodId, target.legalEntityId);
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
        await lockEntity(tx, input.journal.tenantId, input.journal.entityId);
        const period = await lockPeriod(
          tx,
          input.journal.tenantId,
          input.journal.periodId,
          input.journal.entityId,
        );
        // postedAt is the audit timestamp, not the effective accounting date.
        const journalDate = input.journal.journalDate ?? period.endDate;
        assertPeriodRange(journalDate, journalDate);
        if (journalDate < period.startDate || journalDate > period.endDate) {
          throw new KernelError(
            "FIN_INVALID_PERIOD",
            "Journal date is outside the accounting period",
          );
        }
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
            journalId: journalEntry.journalId,
            accountId: journalLine.accountId,
            accountCode: account.code,
            sourceRef: journalEntry.sourceRef,
            report: account.report,
            cashFlow: account.cashFlow,
            currency: journalEntry.currency,
            debitMinor: journalLine.debitMinor,
            creditMinor: journalLine.creditMinor,
            periodId: journalEntry.periodId,
            periodStart: accountingPeriod.startDate,
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
          journalId: row.journalId,
          accountId: row.accountId,
          accountCode: row.accountCode,
          sourceRef: row.sourceRef,
          report: asReport(row.report),
          cashFlow: asCashFlow(row.cashFlow),
          currency: row.currency.trim(),
          debitMinor: minor(row.debitMinor),
          creditMinor: minor(row.creditMinor),
          periodId: row.periodId,
          periodStart: row.periodStart,
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

    commitIngestionPost(input) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await lockLedger(tx, input.tenantId, input.entityId);
        return writeIngestionPost(tx, input);
      });
    },

    runLockedIngestionPost(tenantId, entityId, fn) {
      return tenantTx(db, tenantId, async (tx) => {
        const snapshot = await readLockedLedger(tx, tenantId, entityId);
        const decision = await fn(snapshot);
        if (isIngestionWrite(decision)) await writeIngestionPost(tx, decision.commit);
        return decision;
      });
    },
  };
  return {
    ...core,
    ...createProgramStore(db),
    ...createIdentityStore(db),
    ...createWorkspaceStore(db),
    ...createIngestionStore(db),
  };
}

async function writeIngestionPost(
  tx: AppDatabase,
  input: IngestionPostCommit,
): Promise<{ readonly journalIds: readonly string[] }> {
  for (const created of input.accounts) {
    await tx.insert(account).values({
      accountId: created.accountId,
      tenantId: input.tenantId,
      legalEntityId: input.entityId,
      code: created.code,
      name: created.name,
      report: created.report,
      cashFlow: created.cashFlow,
      currency: input.currency,
      active: true,
      createdAt: input.occurredAt,
    });
    if (created.retainedEarnings) {
      const updated = await tx
        .update(legalEntity)
        .set({ retainedEarningsAccountId: created.accountId })
        .where(
          and(
            eq(legalEntity.tenantId, input.tenantId),
            eq(legalEntity.legalEntityId, input.entityId),
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
  }
  for (const period of input.periods) {
    await tx.insert(accountingPeriod).values({
      periodId: period.periodId,
      tenantId: input.tenantId,
      legalEntityId: input.entityId,
      startDate: period.startDate,
      endDate: period.endDate,
      status: "open",
      createdAt: input.occurredAt,
    });
  }
  const journalIds: string[] = [];
  let inserted = 0;
  for (const journal of input.journals) {
    const existing = await tx
      .select()
      .from(journalEntry)
      .where(
        and(
          eq(journalEntry.tenantId, input.tenantId),
          eq(journalEntry.idempotencyKey, journal.idempotencyKey),
        ),
      )
      .limit(1);
    const prior = existing[0];
    if (prior) {
      if (prior.payloadHash !== journal.payloadHash) {
        throw new KernelError(
          "FIN_IDEMPOTENCY_MISMATCH",
          "Idempotency key was reused with a different payload",
        );
      }
      journalIds.push(prior.journalId);
      continue;
    }
    await tx.insert(journalEntry).values({
      journalId: journal.journalId,
      tenantId: input.tenantId,
      legalEntityId: input.entityId,
      periodId: journal.periodId,
      status: "draft",
      currency: input.currency,
      idempotencyKey: journal.idempotencyKey,
      payloadHash: journal.payloadHash,
      reversesJournalId: null,
      sourceRef: journal.sourceRef,
      actorId: input.actorId,
      correlationId: input.correlationId,
      version: 1,
      createdAt: input.occurredAt,
      postedAt: null,
    });
    if (journal.lines.length > 0) {
      await tx.insert(journalLine).values(
        journal.lines.map((line) => ({
          journalLineId: line.lineId,
          tenantId: input.tenantId,
          journalId: journal.journalId,
          accountId: line.accountId,
          lineNo: line.lineNo,
          debitMinor: line.debitMinor,
          creditMinor: line.creditMinor,
        })),
      );
    }
    await tx
      .update(journalEntry)
      .set({ status: "posted", postedAt: input.occurredAt })
      .where(
        and(
          eq(journalEntry.tenantId, input.tenantId),
          eq(journalEntry.journalId, journal.journalId),
        ),
      );
    await writeAudit(tx, input.tenantId, {
      eventId: crypto.randomUUID(),
      eventType: "JournalPosted",
      aggregateType: "journal",
      aggregateId: journal.journalId,
      actorId: input.actorId,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
      payload: { sourceRef: journal.sourceRef, jobId: input.jobId },
    });
    await tx.insert(domainEvent).values({
      eventId: journal.domainEventId,
      eventType: "JournalPosted",
      eventVersion: 1,
      tenantId: input.tenantId,
      occurredAt: input.occurredAt,
      actorId: input.actorId,
      correlationId: input.correlationId,
      causationId: input.auditEventId,
      aggregateType: "journal",
      aggregateId: journal.journalId,
      payload: { sourceRef: journal.sourceRef, jobId: input.jobId },
    });
    journalIds.push(journal.journalId);
    inserted += 1;
    if (input.fault === "after-first-journal" && inserted === 1) {
      throw new Error("fault:after-first-journal");
    }
  }
  if (input.journals.length > 0) {
    const entityRows = await tx
      .select()
      .from(legalEntity)
      .where(
        and(
          eq(legalEntity.tenantId, input.tenantId),
          eq(legalEntity.legalEntityId, input.entityId),
        ),
      )
      .limit(1);
    const retainedId = entityRows[0]?.retainedEarningsAccountId;
    if (!retainedId) {
      throw new KernelError("FIN_STATEMENT_IMBALANCE", "Entity has no retained earnings account");
    }
    const accountRows = await tx
      .select()
      .from(account)
      .where(and(eq(account.tenantId, input.tenantId), eq(account.legalEntityId, input.entityId)));
    const byId = new Map(accountRows.map((row) => [row.accountId, row]));
    const last = input.journals.length - 1;
    const lines: ClassifiedLine[] = [];
    input.journals.forEach((journal, index) => {
      const period = index === last ? "movement" : "opening";
      for (const line of journal.lines) {
        const row = byId.get(line.accountId);
        if (!row) {
          throw new KernelError("FIN_NOT_FOUND", "Posted line account is missing");
        }
        lines.push({
          accountId: line.accountId,
          report: row.report as ClassifiedLine["report"],
          cashFlow: row.cashFlow as ClassifiedLine["cashFlow"],
          debitMinor: line.debitMinor,
          creditMinor: line.creditMinor,
          currency: input.currency,
          period,
        });
      }
    });
    const statements = buildStatements({
      currency: input.currency,
      retainedEarningsAccountId: retainedId,
      lines,
    });
    if (statements.incomeStatement.netIncomeMinor !== input.netIncomeMinor) {
      throw new KernelError(
        "FIN_STATEMENT_IMBALANCE",
        "Posted statements do not match the linked model",
      );
    }
  }
  if (input.fault === "before-commit") throw new Error("fault:before-commit");
  await tx.insert(calculationRun).values({
    calculationRunId: input.calculationRunId,
    tenantId: input.tenantId,
    kind: "ingestion_model",
    status: "succeeded",
    engineVersion: input.engineVersion,
    inputHash: input.inputHash,
    inputs: { jobId: input.jobId, formulaVersion: input.formulaVersion },
    outputs: { outputHash: input.outputHash, netIncomeMinor: input.netIncomeMinor },
    actorId: input.actorId,
    correlationId: input.correlationId,
    createdAt: input.occurredAt,
  });
  await tx.insert(lineageEdge).values({
    lineageEdgeId: input.lineageEdgeId,
    tenantId: input.tenantId,
    fromType: "ingestion_job",
    fromId: input.jobId,
    toType: "calculation_run",
    toId: input.calculationRunId,
    relation: "posted_model",
    createdAt: input.occurredAt,
  });
  await tx
    .update(ingestionJob)
    .set({
      status: "posted",
      currency: input.currency,
      formulaVersion: input.formulaVersion,
      inputHash: input.inputHash,
      outputHash: input.outputHash,
      canonicalHash: input.canonicalHash,
      modelPayload: { ...input.modelPayload, journals: journalIds },
      updatedAt: input.occurredAt,
    })
    .where(
      and(eq(ingestionJob.tenantId, input.tenantId), eq(ingestionJob.ingestionJobId, input.jobId)),
    );
  await writeAudit(tx, input.tenantId, {
    eventId: input.auditEventId,
    eventType: "IngestionModelPosted",
    aggregateType: "ingestion_job",
    aggregateId: input.jobId,
    actorId: input.actorId,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
    payload: { journalCount: String(journalIds.length), inputHash: input.inputHash },
  });
  return { journalIds };
}

function isIngestionWrite(
  value: unknown,
): value is { action: "write"; commit: IngestionPostCommit } {
  return (
    typeof value === "object" &&
    value !== null &&
    "action" in value &&
    value.action === "write" &&
    "commit" in value
  );
}

async function lockLedger(tx: AppDatabase, tenantId: string, entityId: string): Promise<void> {
  await tx.execute(
    sql`SELECT legal_entity_id FROM legal_entity WHERE tenant_id = ${tenantId} AND legal_entity_id = ${entityId} FOR UPDATE`,
  );
  await tx.execute(
    sql`SELECT period_id FROM accounting_period WHERE tenant_id = ${tenantId} AND legal_entity_id = ${entityId} FOR UPDATE`,
  );
}

async function readLockedLedger(
  tx: AppDatabase,
  tenantId: string,
  entityId: string,
): Promise<LedgerPostSnapshot> {
  await lockLedger(tx, tenantId, entityId);
  const entities = await tx
    .select({
      fiscalYearEndMonth: legalEntity.fiscalYearEndMonth,
      fiscalYearEndDay: legalEntity.fiscalYearEndDay,
      retainedEarningsAccountId: legalEntity.retainedEarningsAccountId,
    })
    .from(legalEntity)
    .where(and(eq(legalEntity.tenantId, tenantId), eq(legalEntity.legalEntityId, entityId)))
    .limit(1);
  const accounts = await tx
    .select()
    .from(account)
    .where(and(eq(account.tenantId, tenantId), eq(account.legalEntityId, entityId)));
  const periods = await tx
    .select()
    .from(accountingPeriod)
    .where(
      and(eq(accountingPeriod.tenantId, tenantId), eq(accountingPeriod.legalEntityId, entityId)),
    );
  const journalRows = await tx
    .select()
    .from(journalEntry)
    .where(
      and(
        eq(journalEntry.tenantId, tenantId),
        eq(journalEntry.legalEntityId, entityId),
        eq(journalEntry.status, "posted"),
      ),
    )
    .orderBy(asc(journalEntry.postedAt));
  const journals: JournalRecord[] = [];
  for (const row of journalRows) {
    if (!row.postedAt) continue;
    const lines = await tx
      .select()
      .from(journalLine)
      .where(and(eq(journalLine.tenantId, tenantId), eq(journalLine.journalId, row.journalId)))
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
  return {
    accounts: accounts.map(mapAccount),
    periods: periods.map(mapPeriod),
    journals,
    fiscalYearEndMonth: entities[0]?.fiscalYearEndMonth ?? null,
    fiscalYearEndDay: entities[0]?.fiscalYearEndDay ?? null,
    retainedEarningsAccountId: entities[0]?.retainedEarningsAccountId ?? null,
  };
}

async function lockEntity(tx: AppDatabase, tenantId: string, entityId: string): Promise<void> {
  const [entity] = await tx
    .select({ id: legalEntity.legalEntityId })
    .from(legalEntity)
    .where(and(eq(legalEntity.tenantId, tenantId), eq(legalEntity.legalEntityId, entityId)))
    .for("update");
  if (!entity) throw new KernelError("FIN_NOT_FOUND", "Legal entity not found");
}

async function lockPeriod(tx: AppDatabase, tenantId: string, periodId: string, entityId: string) {
  const [period] = await tx
    .select()
    .from(accountingPeriod)
    .where(and(eq(accountingPeriod.tenantId, tenantId), eq(accountingPeriod.periodId, periodId)))
    .for("update");
  if (!period || period.legalEntityId !== entityId) {
    throw new KernelError("FIN_INVALID_PERIOD", "Accounting period does not belong to the entity");
  }
  assertPeriodOpen(period.status === "open" ? "open" : "closed");
  return period;
}

function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Opens a company for an owner. The lock and the lookup use the owner and the
 * normalized name. A supplied tenant id is not a reason to return a different company.
 */
async function provisionOwnedTenant(
  db: AppDatabase,
  input: Parameters<LedgerStore["createTenant"]>[0],
): Promise<TenantRecord> {
  const normalized = normalizeCompanyName(input.tenant.name);
  const lockKey = `${input.ownerActorId.length}:${input.ownerActorId}:${normalized}`;
  try {
    return await db.transaction(async (tx) => {
      const scoped = tx as unknown as AppDatabase;
      await scoped.execute(sql.raw("SET LOCAL ROLE nexora_app"));
      await scoped.execute(sql`SELECT set_config('app.actor_id', ${input.ownerActorId}, true)`);
      await scoped.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
      await scoped.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const owned = await scoped
        .select({
          tenantId: tenant.tenantId,
          name: tenant.name,
          homeRegion: tenant.homeRegion,
          status: tenant.status,
          createdAt: tenant.createdAt,
        })
        .from(membership)
        .innerJoin(tenant, eq(membership.tenantId, tenant.tenantId))
        .where(
          and(
            eq(membership.actorId, input.ownerActorId),
            eq(membership.role, "owner"),
            eq(membership.status, "active"),
          ),
        )
        .orderBy(asc(tenant.createdAt), asc(tenant.tenantId));
      const existing = owned.find((row) => normalizeCompanyName(row.name) === normalized);
      if (existing) {
        return {
          tenantId: existing.tenantId,
          name: existing.name,
          homeRegion: existing.homeRegion,
          status: existing.status === "suspended" ? "suspended" : "active",
          createdAt: existing.createdAt,
        } satisfies TenantRecord;
      }
      await scoped.execute(sql`SELECT set_config('app.tenant_id', ${input.tenant.tenantId}, true)`);
      await scoped.insert(tenant).values({
        tenantId: input.tenant.tenantId,
        name: input.tenant.name,
        homeRegion: input.tenant.homeRegion,
        status: input.tenant.status,
        createdAt: input.tenant.createdAt,
      });
      await scoped.insert(membership).values({
        membershipId: input.membershipId,
        tenantId: input.tenant.tenantId,
        actorId: input.ownerActorId,
        role: "owner",
        createdAt: input.tenant.createdAt,
      });
      await writeAudit(scoped, input.tenant.tenantId, input.audit);
      await writeRoleChangeAudit(scoped, {
        actorId: input.ownerActorId,
        tenantId: input.tenant.tenantId,
        role: "owner",
        grantedBy: input.audit.actorId,
        requestId: input.audit.correlationId,
        occurredAt: input.tenant.createdAt,
      });
      return input.tenant;
    });
  } catch (error) {
    rethrowDomain(error);
  }
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
      await tx.execute(
        sql`SELECT set_config('app.actor_id', ${currentRlsSession()?.actorId ?? ""}, true)`,
      );
      return fn(tx as unknown as AppDatabase);
    });
  } catch (error) {
    rethrowDomain(error);
  }
}

/** Sets the actor and the app role without a tenant, so actor-scoped policies apply. */
export async function actorTx<T>(
  db: AppDatabase,
  actorId: string,
  fn: (tx: AppDatabase) => Promise<T>,
): Promise<T> {
  const session = currentRlsSession();
  if (session && session.actorId !== actorId) {
    throw new KernelError("AUTH_SCOPE_DENIED", "The actor does not match the signed-in session");
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE nexora_app"));
      await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.actor_id', ${actorId}, true)`);
      return fn(tx as unknown as AppDatabase);
    });
  } catch (error) {
    rethrowDomain(error);
  }
}

async function companyDetail(
  tx: AppDatabase,
  tenantId: string,
): Promise<Pick<ActorCompany, "entityId" | "periodId" | "members">> {
  const members = await tx
    .select({ actorId: membership.actorId, role: membership.role })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.status, "active")))
    .orderBy(asc(membership.actorId), asc(membership.role));
  const [entity] = await tx
    .select({ id: legalEntity.legalEntityId })
    .from(legalEntity)
    .where(eq(legalEntity.tenantId, tenantId))
    .orderBy(asc(legalEntity.createdAt), asc(legalEntity.legalEntityId))
    .limit(1);
  const [period] = await tx
    .select({ id: accountingPeriod.periodId })
    .from(accountingPeriod)
    .where(eq(accountingPeriod.tenantId, tenantId))
    .orderBy(desc(accountingPeriod.endDate), desc(accountingPeriod.startDate))
    .limit(1);
  return {
    members,
    entityId: entity?.id ?? "",
    periodId: period?.id ?? "",
  };
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
    fiscalYearEndMonth: row.fiscalYearEndMonth,
    fiscalYearEndDay: row.fiscalYearEndDay,
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
