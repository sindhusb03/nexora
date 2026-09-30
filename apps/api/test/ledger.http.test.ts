import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

describe("financial kernel API", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register(...TEST_ACTORS);
  });

  it("serves the engine version and does not compute financial numbers itself", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "financial-kernel",
      engineVersion: "fe-kernel-0.2.0",
    });
  });

  it("posts a balanced company, derives statements, and refuses unsafe writes", async () => {
    const provision = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Northwind", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    expect(provision.status).toBe(201);
    const tenantId = (await readJson<{ tenantId: string }>(provision)).tenantId;

    const entityResponse = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Northwind Inc", functionalCurrency: "USD" },
    });
    const entityId = (await readJson<{ entityId: string }>(entityResponse)).entityId;

    const accounts = {
      cash: await account(app, tenantId, entityId, "1000", "Cash", "asset", "cash"),
      ppe: await account(app, tenantId, entityId, "1500", "PPE", "asset", "cfi"),
      debt: await account(app, tenantId, entityId, "2000", "Debt", "liability", "cff"),
      re: await account(app, tenantId, entityId, "3000", "Retained earnings", "equity", "non_cash", true),
      dividends: await account(app, tenantId, entityId, "3100", "Dividends", "equity", "distribution"),
      revenue: await account(app, tenantId, entityId, "4000", "Revenue", "revenue", "cfo"),
      expense: await account(app, tenantId, entityId, "5000", "Expense", "expense", "cfo"),
    };

    const opening = await period(app, tenantId, entityId, "2023-01-01", "2023-12-31");
    const current = await period(app, tenantId, entityId, "2024-01-01", "2024-12-31");

    await journal(app, tenantId, entityId, opening, "open-1", [
      [accounts.cash, "1000.00", "0.00"],
      [accounts.re, "0.00", "1000.00"],
    ]);
    await journal(app, tenantId, entityId, current, "act-1", [
      [accounts.cash, "800.00", "0.00"],
      [accounts.revenue, "0.00", "800.00"],
    ]);
    await journal(app, tenantId, entityId, current, "act-2", [
      [accounts.expense, "300.00", "0.00"],
      [accounts.cash, "0.00", "300.00"],
    ]);
    await journal(app, tenantId, entityId, current, "act-3", [
      [accounts.ppe, "200.00", "0.00"],
      [accounts.cash, "0.00", "200.00"],
    ]);
    await journal(app, tenantId, entityId, current, "act-4", [
      [accounts.cash, "150.00", "0.00"],
      [accounts.debt, "0.00", "150.00"],
    ]);
    const distribution = await journal(app, tenantId, entityId, current, "act-5", [
      [accounts.dividends, "50.00", "0.00"],
      [accounts.cash, "0.00", "50.00"],
    ]);
    expect(distribution.status).toBe(201);
    const distributionId = (await readJson<{ journalId: string }>(distribution)).journalId;

    const replay = await journal(app, tenantId, entityId, current, "act-5", [
      [accounts.dividends, "50.00", "0.00"],
      [accounts.cash, "0.00", "50.00"],
    ]);
    expect(replay.status).toBe(200);
    expect((await readJson<{ replayed: boolean }>(replay)).replayed).toBe(true);

    const mismatch = await journal(app, tenantId, entityId, current, "act-5", [
      [accounts.dividends, "40.00", "0.00"],
      [accounts.cash, "0.00", "40.00"],
    ]);
    expect(mismatch.status).toBe(409);

    const unbalanced = await journal(app, tenantId, entityId, current, "bad-1", [
      [accounts.cash, "10.00", "0.00"],
      [accounts.revenue, "0.00", "9.00"],
    ]);
    expect(unbalanced.status).toBe(422);

    const statements = await call(
      app,
      "GET",
      `/v1/entities/${entityId}/periods/${current}/statements`,
      { actor: "owner-1", tenant: tenantId, region: "us-east-1" },
    );
    expect(statements.status).toBe(200);
    const body = await readJson<{
      engineVersion: string;
      incomeStatement: { netIncome: { minor: string; amount: string; currency: string } };
      balanceSheet: { assets: { minor: string }; liabilities: { minor: string }; equity: { minor: string } };
      cashFlow: Record<string, { minor: string }>;
      retainedEarnings: { ending: { minor: string }; close: string };
    }>(statements);
    expect(body.incomeStatement.netIncome).toEqual({ minor: "50000", amount: "500.00", currency: "USD" });
    expect(body.balanceSheet.assets.minor).toBe("160000");
    expect(body.balanceSheet.liabilities.minor).toBe("15000");
    expect(body.balanceSheet.equity.minor).toBe("145000");
    expect(body.cashFlow).toMatchObject({
      beginningCash: { minor: "100000" },
      cfo: { minor: "50000" },
      cfi: { minor: "-20000" },
      cff: { minor: "10000" },
      endingCash: { minor: "140000" },
    });
    expect(body.retainedEarnings.ending.minor).toBe("145000");
    expect(body.retainedEarnings.close).toBe("derived");
    expect(body.engineVersion).toBe("fe-kernel-0.2.0");

    await call(app, "POST", "/v1/memberships", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { actorId: "viewer-1", role: "viewer" },
    });
    await call(app, "POST", "/v1/memberships", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { actorId: "auditor-1", role: "auditor" },
    });

    const viewerPost = await journal(app, tenantId, entityId, current, "viewer-1-key", [
      [accounts.cash, "1.00", "0.00"],
      [accounts.revenue, "0.00", "1.00"],
    ], "viewer-1");
    expect(viewerPost.status).toBe(403);

    const viewerRead = await call(app, "GET", `/v1/journals/${distributionId}`, {
      actor: "viewer-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(viewerRead.status).toBe(200);

    const viewerAudit = await call(app, "GET", "/v1/audit", {
      actor: "viewer-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(viewerAudit.status).toBe(403);
    const auditorAudit = await call(app, "GET", "/v1/audit", {
      actor: "auditor-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(auditorAudit.status).toBe(200);
    const auditBody = await readJson<{ events: Array<{ eventType: string }> }>(auditorAudit);
    expect(auditBody.events.some((event: { eventType: string }) => event.eventType === "JournalPosted")).toBe(true);

    const otherTenant = await call(app, "GET", `/v1/journals/${distributionId}`, {
      actor: "owner-1",
      tenant: "99999999-9999-4999-8999-999999999999",
      region: "us-east-1",
    });
    expect(otherTenant.status).toBe(404);

    const wrongRegion = await call(app, "GET", `/v1/entities/${entityId}/periods/${current}/statements`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "eu-central-1",
    });
    expect(wrongRegion.status).toBe(403);

    const closed = await call(app, "POST", `/v1/periods/${current}/close`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(closed.status).toBe(200);
    const afterClose = await journal(app, tenantId, entityId, current, "after-close", [
      [accounts.cash, "1.00", "0.00"],
      [accounts.revenue, "0.00", "1.00"],
    ]);
    expect(afterClose.status).toBe(409);

    const reversal = await call(app, "POST", `/v1/journals/${distributionId}/reverse`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: "rev-closed",
      expectedVersion: "1",
      body: { periodId: current },
    });
    expect(reversal.status).toBe(409);

    const openAgain = await period(app, tenantId, entityId, "2025-01-01", "2025-12-31");
    const reversed = await call(app, "POST", `/v1/journals/${distributionId}/reverse`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: "rev-1",
      expectedVersion: "1",
      body: { periodId: openAgain },
    });
    expect(reversed.status).toBe(201);
    const reversedBody = await readJson<{
      reversesJournalId: string;
      lines: Array<{ debitMinor: string }>;
    }>(reversed);
    expect(reversedBody.reversesJournalId).toBe(distributionId);
    expect(reversedBody.lines[0]?.debitMinor).toBe("0");

    const secondReverse = await call(app, "POST", `/v1/journals/${distributionId}/reverse`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: "rev-2",
      expectedVersion: "1",
      body: { periodId: openAgain },
    });
    expect(secondReverse.status).toBe(409);

    const dcf = await call(app, "POST", "/v1/valuations/dcf", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        currency: "USD",
        freeCashFlows: ["100", "110"],
        wacc: "0.10",
        terminalGrowth: "0.02",
        netDebt: "200",
        nonOperatingAssets: "50",
        otherClaims: "10",
      },
    });
    expect(dcf.status).toBe(201);
    const dcfBody = await readJson<{
      enterpriseValue: string;
      equityValue: string;
      engineVersion: string;
    }>(dcf);
    expect(dcfBody.enterpriseValue).toBe("1340.909090909091");
    expect(dcfBody.equityValue).toBe("1180.909090909091");
    expect(dcfBody.engineVersion).toBe("fe-kernel-0.2.0");

    const rejected = await call(app, "POST", "/v1/valuations/dcf", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        currency: "USD",
        freeCashFlows: ["100"],
        wacc: "0.02",
        terminalGrowth: "0.02",
        netDebt: "0",
        nonOperatingAssets: "0",
        otherClaims: "0",
      },
    });
    expect(rejected.status).toBe(400);
  });
});

async function account(
  app: TestApp,
  tenantId: string,
  entityId: string,
  code: string,
  name: string,
  report: string,
  cashFlow: string,
  retainedEarnings = false,
): Promise<string> {
  const response = await call(app, "POST", "/v1/accounts", {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
    body: { entityId, code, name, report, cashFlow, retainedEarnings },
  });
  expect(response.status).toBe(201);
  return (await readJson<{ accountId: string }>(response)).accountId;
}

async function period(
  app: TestApp,
  tenantId: string,
  entityId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const response = await call(app, "POST", "/v1/periods", {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
    body: { entityId, startDate, endDate },
  });
  expect(response.status).toBe(201);
  return (await readJson<{ periodId: string }>(response)).periodId;
}

async function journal(
  app: TestApp,
  tenantId: string,
  entityId: string,
  periodId: string,
  idempotency: string,
  lines: ReadonlyArray<readonly [string, string, string]>,
  actor = "owner-1",
): Promise<Response> {
  return call(app, "POST", "/v1/journals", {
    actor,
    tenant: tenantId,
    region: "us-east-1",
    idempotency,
    body: {
      entityId,
      periodId,
      currency: "USD",
      lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
    },
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
