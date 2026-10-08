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
      engineVersion: "fe-kernel-0.3.0",
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
      re: await account(
        app,
        tenantId,
        entityId,
        "3000",
        "Retained earnings",
        "equity",
        "non_cash",
        true,
      ),
      dividends: await account(
        app,
        tenantId,
        entityId,
        "3100",
        "Dividends",
        "equity",
        "distribution",
      ),
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
      balanceSheet: {
        assets: { minor: string };
        liabilities: { minor: string };
        equity: { minor: string };
      };
      cashFlow: Record<string, { minor: string }>;
      retainedEarnings: { ending: { minor: string }; close: string };
      final: boolean;
      policy: { label: string; leaseAccounting: string };
      issues: unknown[];
      notices: unknown[];
    }>(statements);
    expect(body.incomeStatement.netIncome).toEqual({
      minor: "50000",
      amount: "500.00",
      currency: "USD",
    });
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
    expect(body.engineVersion).toBe("fe-kernel-0.3.0");
    expect(body.final).toBe(true);
    expect(body.policy).toEqual({ label: "IFRS 16", leaseAccounting: "ifrs16" });
    expect(body.issues).toEqual([]);
    expect(body.notices).toEqual([]);

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

    const viewerPost = await journal(
      app,
      tenantId,
      entityId,
      current,
      "viewer-1-key",
      [
        [accounts.cash, "1.00", "0.00"],
        [accounts.revenue, "0.00", "1.00"],
      ],
      "viewer-1",
    );
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
    expect(
      auditBody.events.some((event: { eventType: string }) => event.eventType === "JournalPosted"),
    ).toBe(true);

    const otherTenant = await call(app, "GET", `/v1/journals/${distributionId}`, {
      actor: "owner-1",
      tenant: "99999999-9999-4999-8999-999999999999",
      region: "us-east-1",
    });
    expect(otherTenant.status).toBe(404);

    const wrongRegion = await call(
      app,
      "GET",
      `/v1/entities/${entityId}/periods/${current}/statements`,
      {
        actor: "owner-1",
        tenant: tenantId,
        region: "eu-central-1",
      },
    );
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
    expect(dcfBody.engineVersion).toBe("fe-kernel-0.3.0");

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

  it("treats only an explicit opening journal as opening, and only in the first period", async () => {
    const provision = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Opening books", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    const tenantId = (await readJson<{ tenantId: string }>(provision)).tenantId;
    const entityId = (
      await readJson<{ entityId: string }>(
        await call(app, "POST", "/v1/entities", {
          actor: "owner-1",
          tenant: tenantId,
          region: "us-east-1",
          body: { legalName: "Opening Co", functionalCurrency: "USD" },
        }),
      )
    ).entityId;
    const cash = await account(app, tenantId, entityId, "1000", "Cash", "asset", "cash");
    const revenue = await account(app, tenantId, entityId, "4000", "Revenue", "revenue", "cfo");
    const re = await account(
      app,
      tenantId,
      entityId,
      "3000",
      "Retained earnings",
      "equity",
      "non_cash",
      true,
    );
    const first = await period(app, tenantId, entityId, "2024-01-01", "2024-12-31");
    const later = await period(app, tenantId, entityId, "2025-01-01", "2025-12-31");

    const opened = await journal(
      app,
      tenantId,
      entityId,
      first,
      "open-kind",
      [
        [cash, "10.00", "0.00"],
        [re, "0.00", "10.00"],
      ],
      "owner-1",
      { journalKind: "opening", sourceRef: "Opening trial balance" },
    );
    expect(opened.status).toBe(201);
    const openingStatement = await readJson<{
      final: boolean;
      policy: { label: string };
      cashFlow: {
        beginningCash: { minor: string };
        cfo: { minor: string };
        endingCash: { minor: string };
      };
      retainedEarnings: { opening: { minor: string } };
    }>(
      await call(app, "GET", `/v1/entities/${entityId}/periods/${first}/statements`, {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
      }),
    );
    expect(openingStatement.final).toBe(true);
    expect(openingStatement.policy.label).toBe("IFRS 16");
    expect(openingStatement.cashFlow).toMatchObject({
      beginningCash: { minor: "1000" },
      cfo: { minor: "0" },
      endingCash: { minor: "1000" },
    });
    expect(openingStatement.retainedEarnings.opening.minor).toBe("1000");

    const labeled = await journal(
      app,
      tenantId,
      entityId,
      first,
      "label-only",
      [
        [cash, "5.00", "0.00"],
        [revenue, "0.00", "5.00"],
      ],
      "owner-1",
      { sourceRef: "Opening trial balance" },
    );
    expect(labeled.status).toBe(201);
    const afterLabel = await readJson<{
      incomeStatement: { netIncome: { minor: string } };
      cashFlow: { beginningCash: { minor: string }; cfo: { minor: string } };
    }>(
      await call(app, "GET", `/v1/entities/${entityId}/periods/${first}/statements`, {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
      }),
    );
    expect(afterLabel.incomeStatement.netIncome.minor).toBe("500");
    expect(afterLabel.cashFlow.beginningCash.minor).toBe("1000");
    expect(afterLabel.cashFlow.cfo.minor).toBe("500");

    const forged = await journal(
      app,
      tenantId,
      entityId,
      first,
      "forged-prefix",
      [
        [cash, "1.00", "0.00"],
        [revenue, "0.00", "1.00"],
      ],
      "owner-1",
      { journalKind: "standard", sourceRef: "opening:forged" },
    );
    expect(forged.status).toBe(422);
    const forgedBody = await readJson<{ error: { message: string } }>(forged);
    expect(forgedBody.error.message).toMatch(/opening journal/i);
    expect(forgedBody.error.message).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );

    const late = await journal(
      app,
      tenantId,
      entityId,
      later,
      "late-opening",
      [
        [cash, "1.00", "0.00"],
        [re, "0.00", "1.00"],
      ],
      "owner-1",
      { journalKind: "opening" },
    );
    expect(late.status).toBe(422);
    const lateBody = await readJson<{ error: { message: string } }>(late);
    expect(lateBody.error.message).toMatch(/first period/i);

    const quiet = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Quiet Co", functionalCurrency: "USD" },
    });
    const quietId = (await readJson<{ entityId: string }>(quiet)).entityId;
    const quietCash = await account(app, tenantId, quietId, "1000", "Cash", "asset", "cash");
    const quietRe = await account(
      app,
      tenantId,
      quietId,
      "3000",
      "Retained earnings",
      "equity",
      "non_cash",
      true,
    );
    await period(app, tenantId, quietId, "2024-01-01", "2024-12-31");
    const quietLater = await period(app, tenantId, quietId, "2025-01-01", "2025-12-31");
    const beforeActivity = await journal(
      app,
      tenantId,
      quietId,
      quietLater,
      "before-activity",
      [
        [quietCash, "4.00", "0.00"],
        [quietRe, "0.00", "4.00"],
      ],
      "owner-1",
      { journalKind: "opening" },
    );
    expect(beforeActivity.status).toBe(201);
  });

  it("returns blocking statement findings and plain failure text", async () => {
    const provision = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Findings books", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    const tenantId = (await readJson<{ tenantId: string }>(provision)).tenantId;
    const entityId = (
      await readJson<{ entityId: string }>(
        await call(app, "POST", "/v1/entities", {
          actor: "owner-1",
          tenant: tenantId,
          region: "us-east-1",
          body: { legalName: "Findings Co", functionalCurrency: "USD" },
        }),
      )
    ).entityId;
    const cash = await account(app, tenantId, entityId, "cash", "Cash", "asset", "cash");
    const fa = await account(
      app,
      tenantId,
      entityId,
      "fixed_assets",
      "Fixed assets",
      "asset",
      "cfi",
    );
    const accum = await account(
      app,
      tenantId,
      entityId,
      "accumulated_depreciation",
      "Accumulated depreciation",
      "asset",
      "non_cash",
    );
    const rouAccum = await account(
      app,
      tenantId,
      entityId,
      "rou_accumulated_depreciation",
      "Accumulated depreciation on right-of-use assets",
      "asset",
      "non_cash",
    );
    const gain = await account(
      app,
      tenantId,
      entityId,
      "gain_loss_on_disposal",
      "Gain or loss on disposal",
      "revenue",
      "cfi",
    );
    const dep = await account(
      app,
      tenantId,
      entityId,
      "depreciation",
      "Depreciation",
      "expense",
      "non_cash",
    );
    await account(
      app,
      tenantId,
      entityId,
      "retained_earnings",
      "Retained earnings",
      "equity",
      "non_cash",
      true,
    );
    const current = await period(app, tenantId, entityId, "2024-01-01", "2024-12-31");
    expect(
      (
        await journal(app, tenantId, entityId, current, "sale", [
          [cash, "3.00", "0.00"],
          [accum, "6.00", "0.00"],
          [fa, "0.00", "8.00"],
          [gain, "0.00", "1.00"],
        ])
      ).status,
    ).toBe(201);
    expect(
      (
        await journal(app, tenantId, entityId, current, "da", [
          [dep, "12.00", "0.00"],
          [accum, "0.00", "10.00"],
          [rouAccum, "0.00", "2.00"],
        ])
      ).status,
    ).toBe(201);

    const response = await call(
      app,
      "GET",
      `/v1/entities/${entityId}/periods/${current}/statements`,
      { actor: "owner-1", tenant: tenantId, region: "us-east-1" },
    );
    expect(response.status).toBe(200);
    const body = await readJson<{
      final: boolean;
      policy: { label: string };
      cashFlow: { cfi: { minor: string } };
      issues: { code: string; message: string; action: string }[];
      notices: unknown[];
    }>(response);
    expect(body.final).toBe(false);
    expect(body.policy.label).toBe("IFRS 16");
    expect(body.cashFlow.cfi.minor).toBe("300");
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.code).toBe("depreciation_split_needed");
    expect(body.issues[0]?.message).toMatch(/Split it so asset sales are read correctly/);
    expect(body.issues[0]?.message).not.toBe("depreciation_split_needed");
    expect(body.issues[0]?.action).toMatch(/Split the combined depreciation line/);
    expect(body.notices).toEqual([]);

    const mystery = await account(
      app,
      tenantId,
      entityId,
      "mystery_equity",
      "Unclassified equity",
      "equity",
      "non_cash",
    );
    expect(
      (
        await journal(app, tenantId, entityId, current, "ambiguous", [
          [cash, "1.00", "0.00"],
          [mystery, "0.00", "1.00"],
        ])
      ).status,
    ).toBe(201);
    const failed = await call(
      app,
      "GET",
      `/v1/entities/${entityId}/periods/${current}/statements`,
      { actor: "owner-1", tenant: tenantId, region: "us-east-1" },
    );
    expect(failed.status).toBe(422);
    const failure = await readJson<{ error: { code: string; message: string } }>(failed);
    expect(failure.error.code).toBe("FIN_STATEMENT_IMBALANCE");
    expect(failure.error.message).toBe(
      "Cash in this journal needs a cash-flow class. Set the class on the account the cash settles.",
    );
    expect(failure.error.message).not.toMatch(/Cash classification needed/);
    expect(failure.error.message).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
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
  extras: { sourceRef?: string; journalKind?: "opening" | "standard" } = {},
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
      ...(extras.sourceRef === undefined ? {} : { sourceRef: extras.sourceRef }),
      ...(extras.journalKind === undefined ? {} : { journalKind: extras.journalKind }),
      lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
    },
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
