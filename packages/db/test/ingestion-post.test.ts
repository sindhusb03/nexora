import { createPgliteStore, type IngestionPostCommit, type LedgerStore } from "@nexora/db";
import { describe, expect, it } from "vitest";

const now = "2026-01-15T00:00:00.000Z";

function audit(eventType: string, aggregateId: string) {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType: "ingestion_job",
    aggregateId,
    actorId: "owner",
    correlationId: "corr",
    occurredAt: now,
    payload: {},
  };
}

async function seed(store: LedgerStore) {
  const tenantId = crypto.randomUUID();
  const entityId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await store.createTenant({
    tenant: {
      tenantId,
      name: "Post",
      homeRegion: "us-east-1",
      status: "active",
      createdAt: now,
    },
    ownerActorId: "owner",
    membershipId: crypto.randomUUID(),
    audit: audit("TenantCreated", tenantId),
  });
  await store.createEntity({
    entity: {
      entityId,
      tenantId,
      legalName: "Post Co",
      functionalCurrency: "USD",
      fiscalYearEndMonth: null,
      fiscalYearEndDay: null,
      retainedEarningsAccountId: null,
    },
    audit: audit("EntityCreated", entityId),
  });
  await store.insertIngestionJob({
    tenantId,
    jobId,
    entityId,
    status: "validating",
    currency: "USD",
    idempotencyKey: null,
    contentHash: "bytes",
    actorId: "owner",
    createdAt: now,
    audit: audit("IngestionJobCreated", jobId),
  });
  return { tenantId, entityId, jobId };
}

function commit(
  ids: { tenantId: string; entityId: string; jobId: string },
  fault?: IngestionPostCommit["fault"],
): IngestionPostCommit {
  const cash = crypto.randomUUID();
  const revenue = crypto.randomUUID();
  const retained = crypto.randomUUID();
  const firstPeriod = crypto.randomUUID();
  const secondPeriod = crypto.randomUUID();
  const firstJournal = crypto.randomUUID();
  const secondJournal = crypto.randomUUID();
  return {
    tenantId: ids.tenantId,
    entityId: ids.entityId,
    jobId: ids.jobId,
    currency: "USD",
    actorId: "owner",
    correlationId: "corr",
    occurredAt: now,
    canonicalHash: "canonical",
    formulaVersion: "ingestion-checks-0.3.0",
    inputHash: "in",
    outputHash: "out",
    netIncomeMinor: "50",
    modelPayload: {},
    engineVersion: "test",
    calculationRunId: crypto.randomUUID(),
    lineageEdgeId: crypto.randomUUID(),
    auditEventId: crypto.randomUUID(),
    ...(fault ? { fault } : {}),
    accounts: [
      {
        accountId: cash,
        code: "cash",
        name: "Cash",
        report: "asset",
        cashFlow: "cash",
        retainedEarnings: false,
      },
      {
        accountId: revenue,
        code: "revenue",
        name: "Revenue",
        report: "revenue",
        cashFlow: "cfo",
        retainedEarnings: false,
      },
      {
        accountId: retained,
        code: "retained_earnings",
        name: "Retained earnings",
        report: "equity",
        cashFlow: "non_cash",
        retainedEarnings: true,
      },
    ],
    periods: [
      { periodId: firstPeriod, startDate: "2023-01-01", endDate: "2023-12-31" },
      { periodId: secondPeriod, startDate: "2024-01-01", endDate: "2024-12-31" },
    ],
    journals: [
      {
        journalId: firstJournal,
        periodId: firstPeriod,
        idempotencyKey: "ingestion:first",
        payloadHash: "hash-1",
        sourceRef: "ingestion:job",
        domainEventId: crypto.randomUUID(),
        lines: [
          {
            lineId: crypto.randomUUID(),
            accountId: cash,
            lineNo: 1,
            debitMinor: "100",
            creditMinor: "0",
          },
          {
            lineId: crypto.randomUUID(),
            accountId: revenue,
            lineNo: 2,
            debitMinor: "0",
            creditMinor: "100",
          },
        ],
      },
      {
        journalId: secondJournal,
        periodId: secondPeriod,
        idempotencyKey: "ingestion:second",
        payloadHash: "hash-2",
        sourceRef: "ingestion:job",
        domainEventId: crypto.randomUUID(),
        lines: [
          {
            lineId: crypto.randomUUID(),
            accountId: cash,
            lineNo: 1,
            debitMinor: "50",
            creditMinor: "0",
          },
          {
            lineId: crypto.randomUUID(),
            accountId: revenue,
            lineNo: 2,
            debitMinor: "0",
            creditMinor: "50",
          },
        ],
      },
    ],
  };
}

describe("atomic ingestion post", () => {
  it("reads committed ledger state inside the locked callback and isolates tenant and entity", async () => {
    const store = await createPgliteStore();
    const ids = await seed(store);
    const other = await seed(store);
    const payload = commit(ids);
    // Queue a writer before the locked reader: the callback must see its committed state.
    const writer = store.commitIngestionPost(payload);
    const reader = store.runLockedIngestionPost(ids.tenantId, ids.entityId, async (snapshot) => {
      expect(snapshot.journals.map((j) => j.journalId).sort()).toEqual(
        payload.journals.map((j) => j.journalId).sort(),
      );
      expect(snapshot.periods.map((p) => p.periodId).sort()).toEqual(
        payload.periods.map((p) => p.periodId).sort(),
      );
      expect(snapshot.accounts).toHaveLength(3);
      expect(
        snapshot.journals.flatMap((j) => j.lines).map((l) => [l.debitMinor, l.creditMinor]),
      ).toEqual([
        ["100", "0"],
        ["0", "100"],
        ["50", "0"],
        ["0", "50"],
      ]);
      expect(snapshot.retainedEarningsAccountId).toBe(
        payload.accounts.find((a) => a.retainedEarnings)?.accountId,
      );
      return { action: "observed" };
    });
    await writer;
    expect(await reader).toEqual({ action: "observed" });
    await store.runLockedIngestionPost(other.tenantId, other.entityId, async (snapshot) => {
      expect(snapshot.journals).toEqual([]);
      expect(snapshot.periods).toEqual([]);
      expect(snapshot.accounts).toEqual([]);
      return { action: "observed" };
    });
  });
  it("rolls back a mid-post fault and posts once on retry", async () => {
    const store = await createPgliteStore();
    const ids = await seed(store);
    await expect(store.commitIngestionPost(commit(ids, "after-first-journal"))).rejects.toThrow(
      /fault:after-first-journal/,
    );
    expect(await store.listJournals(ids.tenantId, ids.entityId, null)).toEqual([]);
    const job = await store.getIngestionJob(ids.tenantId, ids.jobId);
    expect(job?.status).toBe("validating");

    const payload = commit(ids);
    await store.commitIngestionPost(payload);
    const posted = await store.listJournals(ids.tenantId, ids.entityId, null);
    expect(posted).toHaveLength(2);
    expect(posted.every((journal) => journal.reversesJournalId === null)).toBe(true);
    expect(posted.some((journal) => journal.sourceRef?.includes("rollback"))).toBe(false);
    expect((await store.getIngestionJob(ids.tenantId, ids.jobId))?.status).toBe("posted");

    await store.commitIngestionPost({
      ...payload,
      accounts: [],
      periods: [],
      calculationRunId: crypto.randomUUID(),
      lineageEdgeId: crypto.randomUUID(),
      auditEventId: crypto.randomUUID(),
    });
    expect(await store.listJournals(ids.tenantId, ids.entityId, null)).toHaveLength(2);
  });

  it("leaves no journals when the commit faults before it finishes", async () => {
    const store = await createPgliteStore();
    const ids = await seed(store);
    await expect(store.commitIngestionPost(commit(ids, "before-commit"))).rejects.toThrow(
      /fault:before-commit/,
    );
    expect(await store.listJournals(ids.tenantId, ids.entityId, null)).toEqual([]);
    expect(await store.listAccounts(ids.tenantId, ids.entityId)).toEqual([]);
  });
});
