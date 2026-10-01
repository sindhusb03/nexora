import { createPgliteStore, type AuditWrite, type LedgerStore } from "@nexora/db";
import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

describe("ledger integrity at the transaction boundary", () => {
  let store: LedgerStore;
  let app: TestApp;
  let tenantId: string;
  let entityId: string;
  let cash: string;
  let revenue: string;
  let periodId: string;
  const audit = (): AuditWrite => ({
    eventId: crypto.randomUUID(),
    eventType: "IntegrityTest",
    aggregateType: "journal",
    aggregateId: crypto.randomUUID(),
    actorId: "owner-1",
    correlationId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {},
  });
  const request = (method: string, path: string, body?: unknown) =>
    call(app, method, path, {
      actor: "owner-1",
      tenant: tenantId,
      body,
      idempotency: crypto.randomUUID(),
    });

  beforeAll(async () => {
    store = await createPgliteStore();
    app = await testApp({ store });
    await sessions(app).register(...TEST_ACTORS);
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      body: { name: "Integrity", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    tenantId = ((await tenant.json()) as { tenantId: string }).tenantId;
    entityId = (
      (await (
        await request("POST", "/v1/entities", { legalName: "Ledger", functionalCurrency: "USD" })
      ).json()) as { entityId: string }
    ).entityId;
    for (const [code, report, cashFlow, retainedEarnings] of [
      ["cash", "asset", "cash", false],
      ["revenue", "revenue", "cfo", false],
      ["re", "equity", "non_cash", true],
    ] as const) {
      const response = await request("POST", "/v1/accounts", {
        entityId,
        code,
        name: code,
        report,
        cashFlow,
        retainedEarnings,
      });
      expect(response.status).toBe(201);
      const id = ((await response.json()) as { accountId: string }).accountId;
      if (code === "cash") cash = id;
      if (code === "revenue") revenue = id;
    }
    periodId = await period("2024-01-01", "2024-12-31");
  });

  async function period(startDate: string, endDate: string) {
    const result = await request("POST", "/v1/periods", { entityId, startDate, endDate });
    expect(result.status).toBe(201);
    return ((await result.json()) as { periodId: string }).periodId;
  }
  function post(id: string, amount = "10") {
    return request("POST", "/v1/journals", {
      entityId,
      periodId: id,
      currency: "USD",
      lines: [
        { accountId: cash, debit: amount, credit: "0" },
        { accountId: revenue, debit: "0", credit: amount },
      ],
    });
  }
  function direct(id: string, overrides = {}) {
    return store.insertPostedJournal({
      journal: {
        journalId: crypto.randomUUID(),
        tenantId,
        entityId,
        periodId: id,
        currency: "USD",
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "test",
        reversesJournalId: null,
        sourceRef: null,
        actorId: "owner-1",
        correlationId: crypto.randomUUID(),
        version: 1,
        postedAt: new Date().toISOString(),
        ...overrides,
      },
      lines: [
        {
          lineId: crypto.randomUUID(),
          lineNo: 1,
          accountId: cash,
          debitMinor: "100",
          creditMinor: "0",
        },
        {
          lineId: crypto.randomUUID(),
          lineNo: 2,
          accountId: revenue,
          debitMinor: "0",
          creditMinor: "100",
        },
      ],
      audit: audit(),
      domainEventId: crypto.randomUUID(),
    });
  }

  it("rejects a direct store insert into a closed period and HTTP posting returns 409", async () => {
    const closed = await period("2022-01-01", "2022-12-31");
    expect((await request("POST", `/v1/periods/${closed}/close`)).status).toBe(200);
    await expect(direct(closed)).rejects.toMatchObject({ code: "FIN_PERIOD_CLOSED" });
    const response = await post(closed);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "FIN_PERIOD_CLOSED" } });
    expect(await store.listJournals(tenantId, entityId, closed)).toHaveLength(0);
  });

  it("rejects overlapping periods when the service pre-check is bypassed", async () => {
    await expect(
      store.createPeriod({
        period: {
          periodId: crypto.randomUUID(),
          tenantId,
          entityId,
          startDate: "2024-06-01",
          endDate: "2024-12-31",
          status: "open",
        },
        audit: audit(),
      }),
    ).rejects.toMatchObject({ code: "FIN_OVERLAPPING_PERIOD" });
  });

  it("serializes competing period creations", async () => {
    const create = (startDate: string) =>
      store.createPeriod({
        period: {
          periodId: crypto.randomUUID(),
          tenantId,
          entityId,
          startDate,
          endDate: "2027-12-31",
          status: "open",
        },
        audit: audit(),
      });
    const results = await Promise.allSettled([create("2027-01-01"), create("2027-06-01")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "FIN_OVERLAPPING_PERIOD" },
    });
  });

  it("serializes a close with direct posting in both arrival orders", async () => {
    const closedFirst = await period("2028-01-01", "2028-12-31");
    const close = (id: string) => store.closePeriod({ tenantId, periodId: id, audit: audit() });
    const first = await Promise.allSettled([close(closedFirst), direct(closedFirst)]);
    expect(first[0]?.status).toBe("fulfilled");
    expect(first[1]).toMatchObject({ status: "rejected", reason: { code: "FIN_PERIOD_CLOSED" } });
    const postedFirst = await period("2029-01-01", "2029-12-31");
    const second = await Promise.allSettled([direct(postedFirst), close(postedFirst)]);
    expect(second.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await store.listJournals(tenantId, entityId, postedFirst)).toHaveLength(1);
    await expect(direct(postedFirst)).rejects.toMatchObject({ code: "FIN_PERIOD_CLOSED" });
  });

  it("checks the entity and explicit accounting date inside the journal transaction", async () => {
    const other = await request("POST", "/v1/entities", {
      legalName: "Other",
      functionalCurrency: "USD",
    });
    const otherId = ((await other.json()) as { entityId: string }).entityId;
    await expect(direct(periodId, { entityId: otherId })).rejects.toMatchObject({
      code: "FIN_INVALID_PERIOD",
    });
    await expect(direct(periodId, { journalDate: "2025-01-01" })).rejects.toMatchObject({
      code: "FIN_INVALID_PERIOD",
    });
  });

  it("serves P1 statements after P2 activity without including P2 income", async () => {
    const later = await period("2025-01-01", "2025-12-31");
    expect((await post(periodId)).status).toBe(201);
    expect((await post(later, "25")).status).toBe(201);
    const response = await request(
      "GET",
      `/v1/entities/${entityId}/periods/${periodId}/statements`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      incomeStatement: { netIncome: { minor: "1000" } },
      cashFlow: { endingCash: { minor: "1000" } },
    });
    const next = await request("GET", `/v1/entities/${entityId}/periods/${later}/statements`);
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({
      incomeStatement: { netIncome: { minor: "2500" } },
      retainedEarnings: { opening: { minor: "1000" } },
    });
  });
});
