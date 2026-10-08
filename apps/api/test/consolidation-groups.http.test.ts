import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

describe("consolidation group list", () => {
  let app: TestApp;
  let tenantA = "";
  let tenantB = "";
  let groupA = "";

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register(...TEST_ACTORS);
    tenantA = await provision("Groups A", "owner-1");
    tenantB = await provision("Groups B", "owner-2");
    groupA = await createGroup(tenantA, "owner-1", "Alpha", "EUR");
    await createGroup(tenantB, "owner-2", "Beta", "USD");
  });

  it("lists only the signed-in tenant's groups", async () => {
    const listed = await call(app, "GET", "/v1/consolidation-groups", {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      groups: { consolidationGroupId: string; name: string; reportingCurrency: string }[];
    };
    expect(body.groups).toEqual([
      { consolidationGroupId: groupA, name: "Alpha", reportingCurrency: "EUR" },
    ]);

    const other = await call(app, "GET", "/v1/consolidation-groups", {
      actor: "owner-2",
      tenant: tenantB,
      region: "us-east-1",
    });
    expect(other.status).toBe(200);
    const hidden = (await other.json()) as { groups: { name: string }[] };
    expect(hidden.groups.map((group) => group.name)).toEqual(["Beta"]);
    expect(JSON.stringify(hidden)).not.toContain(groupA);
  });

  it("rejects a viewer who cannot run consolidation", async () => {
    const grant = await call(app, "POST", "/v1/memberships", {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
      body: { actorId: "viewer-1", role: "viewer" },
    });
    expect(grant.status).toBe(201);
    const denied = await call(app, "GET", "/v1/consolidation-groups", {
      actor: "viewer-1",
      tenant: tenantA,
      region: "us-east-1",
    });
    expect(denied.status).toBe(403);
  });

  it("returns posted source lines and rate types with the translation", async () => {
    const entityId = await createEntity(tenantA, "owner-1");
    const periodId = await createPeriod(tenantA, "owner-1", entityId);
    const cash = await createAccount(tenantA, "owner-1", entityId, "1000", "Cash", "asset", false);
    const equity = await createAccount(
      tenantA,
      "owner-1",
      entityId,
      "3000",
      "Equity",
      "equity",
      false,
    );
    await createAccount(tenantA, "owner-1", entityId, "3900", "Retained earnings", "equity", true);
    const posted = await call(app, "POST", "/v1/journals", {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
      idempotency: crypto.randomUUID(),
      body: {
        entityId,
        periodId,
        currency: "USD",
        lines: [
          { accountId: cash, debit: "10.00", credit: "0" },
          { accountId: equity, debit: "0", credit: "10.00" },
        ],
      },
    });
    expect(posted.status).toBe(201);

    const translated = await call(app, "POST", `/v1/consolidation-groups/${groupA}/translate`, {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
      body: {
        ctaAccountId: "cta",
        entities: [{ entityId, periodId }],
        rates: [
          {
            sourceCurrency: "USD",
            closing: fx("0.90"),
            historical: fx("0.80"),
            average: fx("0.85"),
          },
        ],
      },
    });
    expect(translated.status).toBe(200);
    const fxBody = (await translated.json()) as {
      ctaMinor: string;
      controlTotalMinor: string;
      inputHash: string;
      outputHash: string;
      calculationRunId: string;
      entities: {
        sourceLines: { accountId: string; rateType: string; debitPositiveMinor: string }[];
        lines: { accountId: string; debitPositiveMinor: string }[];
      }[];
      lines: { accountId: string; debitPositiveMinor: string }[];
    };
    expect(fxBody.ctaMinor).toBe("-100");
    expect(fxBody.controlTotalMinor).toBe("0");
    expect(sourceMap(fxBody.entities[0]?.sourceLines ?? [])).toEqual(
      new Map([
        [cash, { accountId: cash, rateType: "closing", debitPositiveMinor: "1000" }],
        [equity, { accountId: equity, rateType: "historical", debitPositiveMinor: "-1000" }],
      ]),
    );
    expect(fxBody.lines.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n)).toBe(0n);

    const again = await call(app, "POST", `/v1/consolidation-groups/${groupA}/translate`, {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
      body: {
        ctaAccountId: "cta",
        entities: [{ entityId, periodId }],
        rates: [
          {
            sourceCurrency: "USD",
            closing: fx("0.90"),
            historical: fx("0.80"),
            average: fx("0.85"),
          },
        ],
      },
    });
    expect(again.status).toBe(200);
    const repeat = (await again.json()) as {
      inputHash: string;
      outputHash: string;
      calculationRunId: string;
      controlTotalMinor: string;
    };
    expect(repeat.inputHash).toBe(fxBody.inputHash);
    expect(repeat.outputHash).toBe(fxBody.outputHash);
    expect(repeat.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repeat.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repeat.controlTotalMinor).toBe("0");
    expect(repeat.calculationRunId).not.toBe(fxBody.calculationRunId);
  });

  it("deletes a group that has no eliminations", async () => {
    const created = await createGroup(tenantA, "owner-1", "Disposable", "EUR");
    const removed = await call(app, "DELETE", `/v1/consolidation-groups/${created}`, {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
    });
    expect(removed.status).toBe(200);
    const listed = await call(app, "GET", "/v1/consolidation-groups", {
      actor: "owner-1",
      tenant: tenantA,
      region: "us-east-1",
    });
    const body = (await listed.json()) as { groups: { consolidationGroupId: string }[] };
    expect(body.groups.map((group) => group.consolidationGroupId)).not.toContain(created);
  });

  async function provision(name: string, owner: string) {
    const response = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name, homeRegion: "us-east-1", ownerActorId: owner },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { tenantId: string }).tenantId;
  }

  async function createGroup(
    tenant: string,
    actor: string,
    name: string,
    reportingCurrency: string,
  ) {
    const response = await call(app, "POST", "/v1/consolidation-groups", {
      actor,
      tenant,
      region: "us-east-1",
      body: { name, reportingCurrency },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { consolidationGroupId: string }).consolidationGroupId;
  }

  async function createEntity(tenant: string, actor: string) {
    const response = await call(app, "POST", "/v1/entities", {
      actor,
      tenant,
      region: "us-east-1",
      body: { legalName: "OpCo", functionalCurrency: "USD" },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { entityId: string }).entityId;
  }

  async function createPeriod(tenant: string, actor: string, entityId: string) {
    const response = await call(app, "POST", "/v1/periods", {
      actor,
      tenant,
      region: "us-east-1",
      body: { entityId, startDate: "2024-01-01", endDate: "2024-12-31" },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { periodId: string }).periodId;
  }

  async function createAccount(
    tenant: string,
    actor: string,
    entityId: string,
    code: string,
    name: string,
    report: string,
    retainedEarnings: boolean,
  ) {
    const response = await call(app, "POST", "/v1/accounts", {
      actor,
      tenant,
      region: "us-east-1",
      body: { entityId, code, name, report, cashFlow: "non_cash", retainedEarnings },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { accountId: string }).accountId;
  }
});

function sourceMap(
  lines: readonly { accountId: string; rateType: string; debitPositiveMinor: string }[],
) {
  return new Map(lines.map((line) => [line.accountId, line]));
}

function fx(rate: string) {
  return {
    rateSetId: "rates-usd",
    base: "USD",
    quote: "EUR",
    rate,
    rounding: "half_even" as const,
  };
}
