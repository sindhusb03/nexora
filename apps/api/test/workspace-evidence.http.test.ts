import { createHash } from "node:crypto";
import { createPgliteStore, type LedgerStore } from "@nexora/db";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

import { seedDemo } from "../src/demo/seed.js";
import { createLedgerService } from "../src/service.js";
import { createDirectory } from "../src/workspace/directory.js";
import { embedText } from "../src/copilot/retrieval.js";
import { call, testApp, sessions, TEST_PASSWORD } from "./harness.js";

const provider = vi.hoisted(() => ({ prompt: "", response: "Revenue minor 0." }));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: async (input: { prompt: string }) => {
    provider.prompt = input.prompt;
    return { text: provider.response };
  },
}));

interface EvidenceView {
  readonly context: { entityId: string; periodId: string; periodLabel: string };
  readonly latest: { inputHash: string };
  readonly forecast: { drivers: { revenueMinor: string | null }; base: { months: unknown[] } };
  readonly cash: { base: { weeks: unknown[] } };
  readonly variance: unknown;
  readonly qoe: { normalized: string | null };
  readonly onboarding: { certificate: { status: string } };
}
async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const actor = (actorId: string, tenantId: string | null = null) => ({
  actorId,
  tenantId,
  region: "us-east-1",
  correlationId: "evidence-test",
  idempotencyKey: null,
  expectedVersion: null,
  verified: true,
});
const audit = (id: string) => ({
  eventId: crypto.randomUUID(),
  eventType: "TestEvidence",
  aggregateType: "workspace_record",
  aggregateId: id,
  actorId: "owner-1",
  correlationId: "evidence-test",
  occurredAt: new Date().toISOString(),
  payload: {},
});

describe("workspace evidence boundaries", () => {
  let store: LedgerStore;
  beforeAll(async () => {
    store = await createPgliteStore();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function fixture() {
    const directory = createDirectory();
    const app = await testApp({ store, directory, demoMode: false });
    await sessions(app).register("owner-1", "platform-admin");
    const ledger = createLedgerService(store, ["platform-admin"]);
    const tenant = await ledger.provisionTenant(actor("platform-admin"), {
      name: "Real customer",
      homeRegion: "us-east-1",
      ownerActorId: "owner-1",
    });
    const owner = actor("owner-1", tenant.tenantId);
    const entity = await ledger.createEntity(owner, {
      legalName: "Real entity",
      functionalCurrency: "USD",
    });
    await ledger.createAccount(owner, {
      entityId: entity.entityId,
      code: "3000",
      name: "Retained earnings",
      report: "equity",
      cashFlow: "non_cash",
      retainedEarnings: true,
    });
    const period = await ledger.createPeriod(owner, {
      entityId: entity.entityId,
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });
    await ledger.createPeriod(owner, {
      entityId: entity.entityId,
      startDate: "2099-01-01",
      endDate: "2099-12-31",
    });
    directory.upsert({
      tenantId: tenant.tenantId,
      name: tenant.name,
      region: "us-east-1",
      status: "active",
      entityId: entity.entityId,
      periodId: period.periodId,
      members: [{ actorId: "owner-1", role: "owner" }],
    });
    return {
      app,
      directory,
      tenant: tenant.tenantId,
      entity: entity.entityId,
      period: period.periodId,
      ledger,
      owner,
    };
  }

  async function record(
    tenantId: string,
    kind: string,
    payload: Record<string, unknown>,
    status = "suggested",
  ) {
    const id = crypto.randomUUID();
    await store.insertWorkspaceRecord({
      tenantId,
      id,
      kind,
      status,
      payload,
      createdAt: new Date().toISOString(),
      audit: audit(id),
    });
    return id;
  }

  it("withholds demo panels, bank certification and demo actors from real tenants", async () => {
    const f = await fixture();
    const response = await call(f.app, "GET", "/v1/workspace", {
      actor: "owner-1",
      tenant: f.tenant,
    });
    expect(response.status).toBe(200);
    const body = await readJson<EvidenceView>(response);
    for (const key of ["forecast", "cash", "variance", "qoe"] as const) {
      expect(body[key]).toMatchObject({ status: "unavailable", reason: "no tenant plan data" });
    }
    expect(body.forecast.drivers.revenueMinor).toBeNull();
    expect(body.qoe.normalized).toBeNull();
    expect(body.onboarding.certificate).toMatchObject({
      status: "unavailable",
      bankCashMinor: null,
      sourceDocument: null,
    });
    expect(JSON.stringify(body)).not.toContain("sindhu");
    const companies = await call(f.app, "GET", "/v1/workspace/companies", { actor: "owner-1" });
    expect(
      (await readJson<{ companies: { support: boolean }[] }>(companies)).companies[0]?.support,
    ).toBe(false);
    const reply = await call(f.app, "POST", "/v1/copilot", {
      actor: "owner-1",
      tenant: f.tenant,
      body: { message: "Show the forecast and QoE", agent: "normalization" },
    });
    expect((await readJson<{ text: string }>(reply)).text).toMatch(/no (tenant )?plan data/i);
  });

  it("selects historical periods, excludes future defaults and rejects foreign IDs", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const options = { actor: "owner-1", tenant: f.tenant };
    const selected = await call(f.app, "GET", "/v1/workspace", options);
    expect((await readJson<EvidenceView>(selected)).context).toMatchObject({
      entityId: f.entity,
      periodId: f.period,
    });
    expect(
      (await call(f.app, "GET", `/v1/workspace?entityId=${foreign.entity}`, options)).status,
    ).toBe(404);
    expect(
      (await call(f.app, "GET", `/v1/workspace?periodId=${foreign.period}`, options)).status,
    ).toBe(404);
    const historical = await call(f.app, "GET", `/v1/workspace?periodId=${f.period}`, options);
    expect(historical.status).toBe(200);
    expect((await readJson<EvidenceView>(historical)).context.periodLabel).toBe("2024-12-31");
  });

  it("reconciles only against a matching independent bank import", async () => {
    const f = await fixture();
    await record(
      f.tenant,
      "bank_import",
      { entityId: f.entity, periodId: f.period, currency: "USD", closingBalanceMinor: "10" },
      "imported",
    );
    const read = async () =>
      (
        await readJson<EvidenceView>(
          await call(f.app, "GET", "/v1/workspace", { actor: "owner-1", tenant: f.tenant }),
        )
      ).onboarding.certificate;
    expect(await read()).toMatchObject({
      status: "unreconciled",
      bankCashMinor: "10",
      gapMinor: "-10",
    });
    await record(
      f.tenant,
      "bank_import",
      { entityId: f.entity, periodId: f.period, currency: "USD", closingBalanceMinor: "0" },
      "imported",
    );
    expect(await read()).toMatchObject({ status: "reconciled", bankCashMinor: "0", gapMinor: "0" });
  });

  it("audits the reviewed proposal and rejects duplicate or stale decisions", async () => {
    const f = await fixture();
    const payload = { title: "Tenant adjustment", amount: "100", sourceRowId: "row" };
    const id = await record(f.tenant, "proposal", payload);
    const decide = (proposal: string, body: unknown) =>
      call(f.app, "POST", `/v1/workspace/proposals/${proposal}/decide`, {
        actor: "owner-1",
        tenant: f.tenant,
        body,
      });
    expect(
      (
        await decide(id, {
          decision: "accepted",
          expectedStatus: "suggested",
          reason: "Verified source",
        })
      ).status,
    ).toBe(200);
    const event = (await store.listAudit(f.tenant)).find(
      (item) => item.eventType === "ProposalDecided",
    );
    expect(event?.payload).toMatchObject({
      from: "suggested",
      to: "accepted",
      action: "accepted",
      reason: "Verified source",
      decidedBy: "owner-1",
      contentHash: createHash("sha256")
        .update(JSON.stringify({ amount: "100", sourceRowId: "row", title: "Tenant adjustment" }))
        .digest("hex"),
      decidedAt: expect.any(String),
    });
    expect((await decide(id, { decision: "rejected" })).status).toBe(409);
    const stale = await record(f.tenant, "proposal", payload);
    expect((await decide(stale, { decision: "accepted", expectedStatus: "pending" })).status).toBe(
      409,
    );
    expect(
      (await store.listWorkspaceRecords(f.tenant, "proposal")).find((item) => item.id === stale)
        ?.status,
    ).toBe("suggested");
    expect(
      (await store.listAudit(f.tenant)).filter((item) => item.eventType === "ProposalDecided"),
    ).toHaveLength(1);
  });

  it("targets only the explicit flag tenant and rejects missing, foreign or unauthorized targets", async () => {
    const first = await fixture();
    const second = await fixture();
    const card = second.directory.list()[0];
    if (card) first.directory.upsert(card);
    const firstId = await record(first.tenant, "flag", { enabled: true }, "active");
    const secondId = await record(second.tenant, "flag", { enabled: true }, "active");
    const flag = (id: string, tenantId: string, who = "platform-admin") =>
      call(first.app, "POST", `/v1/admin/flags/${id}`, {
        actor: who,
        body: { tenantId, enabled: false },
      });
    expect((await flag(secondId, second.tenant)).status).toBe(200);
    expect((await store.listWorkspaceRecords(second.tenant, "flag"))[0]?.payload.enabled).toBe(
      false,
    );
    expect((await store.listWorkspaceRecords(first.tenant, "flag"))[0]?.payload.enabled).toBe(true);
    expect((await flag(firstId, second.tenant)).status).toBe(404);
    expect((await flag(firstId, crypto.randomUUID())).status).toBe(404);
    expect((await flag(firstId, first.tenant, "owner-1")).status).toBe(403);
  });

  it("rejects absent and expired support expiry, and rolls back membership on record failure", async () => {
    const f = await fixture();
    const grant = (body: unknown) =>
      call(f.app, "POST", "/v1/admin/support", { actor: "platform-admin", body });
    expect((await grant({ tenantId: f.tenant, reason: "Investigate" })).status).toBe(422);
    expect(
      (
        await grant({
          tenantId: f.tenant,
          reason: "Investigate",
          expiresAt: "2000-01-01T00:00:00Z",
        })
      ).status,
    ).toBe(422);
    const existingId = await record(f.tenant, "support", {}, "expired");
    // A duplicate record key fails at the database insert after the membership insert.
    const original = store.grantSupportAccess?.bind(store);
    if (original)
      vi.spyOn(store, "grantSupportAccess").mockImplementation((input) =>
        original({ ...input, id: existingId }),
      );
    else
      vi.spyOn(store, "insertWorkspaceRecord").mockRejectedValue(
        new Error("injected record failure"),
      );
    expect((await grant({ tenantId: f.tenant, hours: 1, reason: "Investigate" })).status).toBe(500);
    expect(await store.listRoles(f.tenant, "platform-admin")).toEqual([]);
    expect(
      (await store.listAudit(f.tenant)).filter((event) => event.eventType === "SupportGranted"),
    ).toHaveLength(0);
  });

  it("records the exact live corpus hash, byte count and source IDs without document text", async () => {
    const f = await fixture();
    const documentId = await record(
      f.tenant,
      "document",
      { title: "Bank context", body: "Private context 999", embedding: embedText("Bank context") },
      "active",
    );
    vi.stubEnv("AI_API_KEY", "test-provider-key");
    vi.stubEnv("AI_MODEL", "test-model");
    provider.response = "999 [unknown]";
    const response = await call(f.app, "POST", "/v1/copilot", {
      actor: "owner-1",
      tenant: f.tenant,
      body: { message: "Explain revenue" },
    });
    expect(response.status).toBe(200);
    expect((await readJson<{ accepted: boolean }>(response)).accepted).toBe(false);
    const corpus = provider.prompt.split("Tool corpus:\n")[1] ?? "";
    const run = (await store.listWorkspaceRecords(f.tenant, "ai_run"))[0];
    expect(run?.payload).toMatchObject({
      corpusSha256: createHash("sha256").update(corpus).digest("hex"),
      corpusBytes: Buffer.byteLength(corpus),
      factIds: expect.arrayContaining([expect.any(String)]),
      documentIds: [documentId],
      provider: "openai",
      model: "test-model",
    });
    expect(JSON.stringify(run?.payload)).not.toContain("Private context");
    const snapshot = await readJson<EvidenceView>(
      await call(f.app, "GET", "/v1/workspace", { actor: "owner-1", tenant: f.tenant }),
    );
    provider.response = `Revenue minor 0 [${snapshot.latest.inputHash}]`;
    const grounded = await call(f.app, "POST", "/v1/copilot", {
      actor: "owner-1",
      tenant: f.tenant,
      body: { message: "Explain revenue" },
    });
    expect((await readJson<{ accepted: boolean }>(grounded)).accepted).toBe(true);
  });

  it("keeps demo forecasts available only with explicit demo mode", async () => {
    const demoStore = await createPgliteStore();
    const directory = createDirectory();
    await seedDemo(demoStore, directory, ["platform-admin"], 1024, TEST_PASSWORD);
    const app = await testApp({ store: demoStore, directory, demoMode: true });
    const response = await call(app, "GET", "/v1/workspace", {
      actor: "sindhu",
      tenant: directory.list()[0]?.tenantId ?? "",
    });
    expect(response.status).toBe(200);
    const body = await readJson<EvidenceView>(response);
    expect(body.forecast.base.months).toHaveLength(12);
    expect(body.cash.base.weeks).toHaveLength(13);
    expect(body.qoe.normalized).not.toBeNull();
    expect(body.onboarding.certificate.status).toBe("unavailable");
  });
});
