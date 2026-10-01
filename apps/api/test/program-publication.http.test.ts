import { createPgliteStore, type LedgerStore } from "@nexora/db";
import { hashMaterial } from "@nexora/kernel";
import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

describe("kernel-derived financial state and atomic publication", () => {
  let store: LedgerStore;
  let app: TestApp;
  let tenantId: string;
  let entityId: string;
  let periodId: string;
  let foreignTenant: string;
  let foreignEntity: string;
  let foreignPeriod: string;
  let failAt: "approval" | "lineage" | null = null;
  const attemptedSuccessors: string[] = [];
  const request = (
    method: string,
    path: string,
    body?: unknown,
    actor = "owner-1",
    tenant = tenantId,
  ) => call(app, method, path, { actor, tenant, body });

  beforeAll(async () => {
    store = await createPgliteStore();
    const wrapped: LedgerStore = {
      ...store,
      insertFinancialState(input) {
        if (input.supersedesId) attemptedSuccessors.push(input.id);
        return store.insertFinancialState(input);
      },
      insertApproval(input) {
        return store.insertApproval(
          failAt === "approval" ? { ...input, approvalId: "invalid-uuid" } : input,
        );
      },
      transitionFinancialStateAtomic(input) {
        attemptedSuccessors.push(input.successor.id);
        return store.transitionFinancialStateAtomic({
          ...input,
          approval:
            failAt === "approval"
              ? { ...input.approval, approvalId: "invalid-uuid" }
              : input.approval,
          lineage:
            failAt === "lineage"
              ? { ...input.lineage, lineageEdgeId: "invalid-uuid" }
              : input.lineage,
        });
      },
    };
    app = await testApp({ store: wrapped });
    await sessions(app).register(...TEST_ACTORS);
    for (const actor of ["owner-1", "owner-2"]) {
      const tenant = await call(app, "POST", "/v1/tenants", {
        actor: "platform-admin",
        body: { name: actor, homeRegion: "us-east-1", ownerActorId: actor },
      });
      const tenantKey = ((await tenant.json()) as { tenantId: string }).tenantId;
      const entity = await request(
        "POST",
        "/v1/entities",
        { legalName: actor, functionalCurrency: "USD" },
        actor,
        tenantKey,
      );
      const entityKey = ((await entity.json()) as { entityId: string }).entityId;
      const period = await request(
        "POST",
        "/v1/periods",
        { entityId: entityKey, startDate: "2024-01-01", endDate: "2024-12-31" },
        actor,
        tenantKey,
      );
      const periodKey = ((await period.json()) as { periodId: string }).periodId;
      if (actor === "owner-2") {
        foreignTenant = tenantKey;
        foreignEntity = entityKey;
        foreignPeriod = periodKey;
        continue;
      }
      tenantId = tenantKey;
      entityId = entityKey;
      periodId = periodKey;
      const accounts: Record<string, string> = {};
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
        accounts[code] = ((await response.json()) as { accountId: string }).accountId;
      }
      const posted = await call(app, "POST", "/v1/journals", {
        actor,
        tenant: tenantId,
        idempotency: crypto.randomUUID(),
        body: {
          entityId,
          periodId,
          currency: "USD",
          lines: [
            { accountId: accounts.cash, debit: "125", credit: "0" },
            { accountId: accounts.revenue, debit: "0", credit: "125" },
          ],
        },
      });
      expect(posted.status).toBe(201);
      expect(
        (await request("POST", "/v1/memberships", { actorId: "controller-1", role: "controller" }))
          .status,
      ).toBe(201);
    }
  });

  async function draft(extra: Record<string, unknown> = {}) {
    // Matching legacy input lets transaction tests reach the old publication path on main.
    const response = await request("POST", "/v1/financial-states", {
      entityId,
      periodId,
      basis: "us-gaap",
      currency: "USD",
      netIncomeMinor: "12500",
      ...extra,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { financialStateId: string; stateHash: string };
  }
  const transition = (id: string, to = "validated", actor = "owner-1") =>
    request("POST", `/v1/financial-states/${id}/transition`, { to }, actor);

  it("rejects nonexistent, foreign, and mismatched entity/period IDs", async () => {
    for (const ids of [
      { entityId: crypto.randomUUID(), periodId },
      { entityId, periodId: crypto.randomUUID() },
      { entityId: foreignEntity, periodId: foreignPeriod },
      { entityId, periodId: foreignPeriod },
    ]) {
      const response = await request("POST", "/v1/financial-states", {
        ...ids,
        basis: "us-gaap",
        currency: "USD",
        netIncomeMinor: "12500",
      });
      expect([404, 422]).toContain(response.status);
    }
  });

  it("drafts without a client total or currency and links the actual statement calculation", async () => {
    const response = await request("POST", "/v1/financial-states", {
      entityId,
      periodId,
      basis: "us-gaap",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { financialStateId: string; stateHash: string };
    expect(body).toMatchObject({ netIncomeMinor: "12500", currency: "USD" });
    const stored = await store.getFinancialState(tenantId, body.financialStateId);
    expect(stored).toMatchObject({
      calculationStatus: "succeeded",
      payload: { netIncomeMinor: "12500", currency: "USD" },
    });
    expect(stored?.calculationRunId).toBeTruthy();
    const run = await store.getCalculationRun(tenantId, stored!.calculationRunId!);
    expect(run).toMatchObject({ kind: "statements", status: "succeeded" });
    expect(stored?.payload).toMatchObject({
      inputHash: run?.inputHash,
      outputHash: hashMaterial(run!.outputs),
      engineVersion: run?.engineVersion,
    });
    const read = await request("GET", `/v1/financial-states/${body.financialStateId}`);
    expect(await read.json()).toMatchObject({ netIncomeMinor: "12500", currency: "USD" });
  });

  it("rejects a mismatching client total with 422", async () => {
    const response = await request("POST", "/v1/financial-states", {
      entityId,
      periodId,
      basis: "us-gaap",
      currency: "USD",
      netIncomeMinor: "999999",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "FIN_CLIENT_TOTAL_MISMATCH" } });
  });

  it("allows exactly one successor, approval, and lineage edge for competing transitions", async () => {
    const current = await draft();
    const before = attemptedSuccessors.length;
    const results = await Promise.all([
      transition(current.financialStateId),
      transition(current.financialStateId),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const conflict = results.find((result) => result.status === 409)!;
    expect(await conflict.json()).toMatchObject({ error: { code: "FIN_VERSION_CONFLICT" } });
    const successors = await Promise.all(
      attemptedSuccessors.slice(before).map((id) => store.getFinancialState(tenantId, id)),
    );
    expect(successors.filter(Boolean)).toHaveLength(1);
    const edges = await store.listLineage(tenantId, "financial_state", current.financialStateId);
    expect(edges).toHaveLength(1);
    const events = await store.listAudit(tenantId);
    expect(
      events.filter(
        (event) => event.eventType === "ApprovalRecorded" && event.aggregateId === edges[0]?.toId,
      ),
    ).toHaveLength(1);
    expect((await transition(current.financialStateId)).status).toBe(409);
  });

  it.each(["approval", "lineage"] as const)(
    "rolls back the successor, approval, lineage, and audits when %s insertion fails",
    async (stage) => {
      const current = await draft();
      const before = attemptedSuccessors.length;
      const auditBefore = (await store.listAudit(tenantId)).length;
      failAt = stage;
      let response: Response;
      try {
        response = await transition(current.financialStateId);
      } finally {
        failAt = null;
      }
      expect(response.status).toBe(500);
      expect(attemptedSuccessors.length).toBe(before + 1);
      expect(await store.getFinancialState(tenantId, attemptedSuccessors[before]!)).toBeNull();
      expect(
        await store.listLineage(tenantId, "financial_state", current.financialStateId),
      ).toHaveLength(0);
      expect(await store.listAudit(tenantId)).toHaveLength(auditBefore);
      expect((await transition(current.financialStateId)).status).toBe(200);
    },
  );

  it("uses the stored failed calculation status when checking publication", async () => {
    const current = await draft();
    const stored = await store.getFinancialState(tenantId, current.financialStateId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await store.insertFinancialState({
      tenantId,
      id,
      entityId,
      periodId,
      basis: "us-gaap",
      currency: "USD",
      stateHash: current.stateHash,
      status: "approved",
      engineVersion: stored!.engineVersion,
      calculationStatus: "failed",
      calculationRunId: null,
      supersedesId: null,
      makerActorId: "owner-1",
      payload: stored!.payload as Record<string, unknown>,
      createdAt: now,
      audit: {
        eventId: crypto.randomUUID(),
        eventType: "FailedStateFixture",
        aggregateType: "financial_state",
        aggregateId: id,
        actorId: "owner-1",
        correlationId: crypto.randomUUID(),
        occurredAt: now,
        payload: {},
      },
    });
    const result = await transition(id, "published", "controller-1");
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: "PUBLISH_BLOCKED" } });
  });

  it("rejects another tenant's model parent on save and calculation", async () => {
    const response = await request(
      "POST",
      "/v1/models",
      { name: "Foreign" },
      "owner-2",
      foreignTenant,
    );
    const modelId = ((await response.json()) as { modelId: string }).modelId;
    for (const suffix of ["versions", "calculate"]) {
      const result = await request("POST", `/v1/models/${modelId}/${suffix}`, {
        nodes: [{ id: "x", type: "constant", value: "1" }],
      });
      expect(result.status).toBe(404);
    }
  });

  it("refuses a bare successor insert that bypasses the atomic transition", async () => {
    const current = await draft();
    const stored = await store.getFinancialState(tenantId, current.financialStateId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await expect(
      store.insertFinancialState({
        tenantId,
        id,
        entityId,
        periodId,
        basis: "us-gaap",
        currency: "USD",
        stateHash: current.stateHash,
        status: "validated",
        engineVersion: stored!.engineVersion,
        calculationStatus: "succeeded",
        calculationRunId: stored!.calculationRunId,
        supersedesId: current.financialStateId,
        makerActorId: "owner-1",
        payload: stored!.payload as Record<string, unknown>,
        createdAt: now,
        audit: {
          eventId: crypto.randomUUID(),
          eventType: "BareSuccessor",
          aggregateType: "financial_state",
          aggregateId: id,
          actorId: "owner-1",
          correlationId: crypto.randomUUID(),
          occurredAt: now,
          payload: {},
        },
      }),
    ).rejects.toMatchObject({ code: "FIN_VERSION_CONFLICT" });
    expect(await store.getFinancialState(tenantId, id)).toBeNull();
  });

  it("checks consolidation and debt parents under the caller's tenant", async () => {
    const group = await request(
      "POST",
      "/v1/consolidation-groups",
      { name: "Foreign group", reportingCurrency: "EUR" },
      "owner-2",
      foreignTenant,
    );
    const groupId = ((await group.json()) as { consolidationGroupId: string }).consolidationGroupId;
    const rate = {
      rateSetId: "rates",
      base: "USD",
      quote: "EUR",
      rate: "1",
      rounding: "half_even",
    };
    const translated = await request("POST", `/v1/consolidation-groups/${groupId}/translate`, {
      sourceCurrency: "USD",
      ctaAccountId: "cta",
      lines: [
        { accountId: "cash", rateType: "closing", debitPositiveMinor: "100" },
        { accountId: "equity", rateType: "historical", debitPositiveMinor: "-100" },
      ],
      rates: { closing: rate, historical: rate, average: rate },
    });
    expect(translated.status).toBe(404);
    const eliminated = await request("POST", `/v1/consolidation-groups/${groupId}/eliminate`, {
      evidenceId: "ic",
      balances: [
        { accountId: "ar", debitPositiveMinor: "10" },
        { accountId: "ap", debitPositiveMinor: "-10" },
      ],
      eliminations: [
        { accountId: "ar", debitMinor: "0", creditMinor: "10", evidenceId: "ic" },
        { accountId: "ap", debitMinor: "10", creditMinor: "0", evidenceId: "ic" },
      ],
    });
    expect(eliminated.status).toBe(404);
    const debt = await request("POST", "/v1/capital/debt", {
      entityId: foreignEntity,
      name: "Foreign debt",
      openingMinor: "100",
      drawMinor: "0",
      repaymentMinor: "0",
      accruedInterestMinor: "0",
    });
    expect(debt.status).toBe(404);
  });

  it("checks other program parents before writing", async () => {
    const foreignModel = await request(
      "POST",
      "/v1/models",
      { name: "Scenario parent" },
      "owner-2",
      foreignTenant,
    );
    const modelId = ((await foreignModel.json()) as { modelId: string }).modelId;
    const version = await request(
      "POST",
      `/v1/models/${modelId}/versions`,
      { nodes: [{ id: "x", type: "constant", value: "1" }] },
      "owner-2",
      foreignTenant,
    );
    const baseVersionId = ((await version.json()) as { modelVersionId: string }).modelVersionId;
    expect(
      (
        await request("POST", "/v1/scenarios", {
          baseVersionId,
          name: "Cross tenant",
          base: { x: "1" },
          overrides: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("POST", "/v1/capital/cap-table", {
          entityId: foreignEntity,
          holdings: [{ holderId: "a", commonShares: "100", options: "0", convertibles: "0" }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("POST", "/v1/ownership", {
          asOf: "2024-12-31",
          parentEntityId: entityId,
          childEntityId: foreignEntity,
          effectiveFrom: "2024-01-01",
          effectiveTo: null,
          percent: "0.6",
          subsidiaryEquityMinor: "100",
        })
      ).status,
    ).toBe(404);
  });
});
