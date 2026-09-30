import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

describe("ledger lists", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register(...TEST_ACTORS);
  });

  it("returns only the caller's entities, accounts, periods, and journals", async () => {
    const first = await provision(app, "Northwind");
    const second = await provision(app, "Other");
    const entityId = await createEntity(app, first);
    const hidden = await createEntity(app, second);

    const entities = await readJson<{ entities: Array<{ entityId: string }> }>(
      await call(app, "GET", "/v1/entities", first),
    );
    expect(entities.entities.map((entity) => entity.entityId)).toEqual([entityId]);
    expect(entities.entities.some((entity) => entity.entityId === hidden)).toBe(false);

    const accountResponse = await call(app, "POST", "/v1/accounts", {
      ...first,
      body: {
        entityId,
        code: "3000",
        name: "Retained earnings",
        report: "equity",
        cashFlow: "non_cash",
        retainedEarnings: true,
      },
    });
    expect(accountResponse.status).toBe(201);

    const accounts = await readJson<{
      accounts: Array<{ code: string; retainedEarnings: boolean }>;
    }>(await call(app, "GET", `/v1/entities/${entityId}/accounts`, first));
    expect(accounts.accounts).toEqual([
      expect.objectContaining({ code: "3000", retainedEarnings: true, currency: "USD" }),
    ]);

    const periodResponse = await call(app, "POST", "/v1/periods", {
      ...first,
      body: { entityId, startDate: "2024-01-01", endDate: "2024-12-31" },
    });
    const periodId = (await readJson<{ periodId: string }>(periodResponse)).periodId;
    const periods = await readJson<{ periods: Array<{ periodId: string; status: string }> }>(
      await call(app, "GET", `/v1/entities/${entityId}/periods`, first),
    );
    expect(periods.periods).toEqual([expect.objectContaining({ periodId, status: "open" })]);

    const cash = await readJson<{ accountId: string }>(
      await call(app, "POST", "/v1/accounts", {
        ...first,
        body: {
          entityId,
          code: "1000",
          name: "Cash",
          report: "asset",
          cashFlow: "cash",
          retainedEarnings: false,
        },
      }),
    );
    const revenue = await readJson<{ accountId: string }>(
      await call(app, "POST", "/v1/accounts", {
        ...first,
        body: {
          entityId,
          code: "4000",
          name: "Revenue",
          report: "revenue",
          cashFlow: "cfo",
          retainedEarnings: false,
        },
      }),
    );
    const posted = await call(app, "POST", "/v1/journals", {
      ...first,
      idempotency: "list-1",
      body: {
        entityId,
        periodId,
        currency: "USD",
        lines: [
          { accountId: cash.accountId, debit: "10.00", credit: "0.00" },
          { accountId: revenue.accountId, debit: "0.00", credit: "10.00" },
        ],
      },
    });
    expect(posted.status).toBe(201);
    const journals = await readJson<{
      journals: Array<{ totalDebit: string; payloadHash: string }>;
    }>(await call(app, "GET", `/v1/entities/${entityId}/journals?periodId=${periodId}`, first));
    expect(journals.journals).toHaveLength(1);
    expect(journals.journals[0]?.totalDebit).toBe("10.00");
    expect(journals.journals[0]?.payloadHash).toHaveLength(64);

    const viewer = await call(
      app,
      "GET",
      `/v1/entities/${entityId}/journals?periodId=${periodId}`,
      {
        actor: "viewer-1",
        tenant: first.tenant,
        region: first.region,
      },
    );
    expect(viewer.status).toBe(403);
  });
});

async function provision(
  app: TestApp,
  name: string,
): Promise<{ actor: string; tenant: string; region: string }> {
  const response = await call(app, "POST", "/v1/tenants", {
    actor: "platform-admin",
    region: "us-east-1",
    body: { name, homeRegion: "us-east-1", ownerActorId: "owner-1" },
  });
  const body = await readJson<{ tenantId: string }>(response);
  return { actor: "owner-1", tenant: body.tenantId, region: "us-east-1" };
}

async function createEntity(
  app: TestApp,
  scope: { actor: string; tenant: string; region: string },
): Promise<string> {
  const response = await call(app, "POST", "/v1/entities", {
    ...scope,
    body: { legalName: "OpCo", functionalCurrency: "USD" },
  });
  return (await readJson<{ entityId: string }>(response)).entityId;
}

async function readJson<T>(response: Response): Promise<T> {
  expect(response.status).toBeLessThan(400);
  return (await response.json()) as T;
}
