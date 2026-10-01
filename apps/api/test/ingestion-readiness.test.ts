import { createPgliteStore } from "@nexora/db";
import { expect, it, vi } from "vitest";
import { testApp, sessions } from "./harness.js";
import { call } from "./harness.js";
import { createIngestionService } from "../src/ingestion/service.js";

it("readiness requires both renumbered ingestion migrations", async () => {
  const store = await createPgliteStore();
  const app = await testApp({ store });
  const names = await store.appliedMigrations();
  expect(names).toContain("0006_ingestion.sql");
  expect(names).toContain("0007_fiscal_year_end.sql");
  expect((await app.request("/readyz")).status).toBe(200);
  const applied = vi.spyOn(store, "appliedMigrations");
  for (const name of ["0006_ingestion.sql", "0007_fiscal_year_end.sql"]) {
    applied.mockResolvedValue(names.filter((n) => n !== name));
    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "migrations_pending" });
  }
  applied.mockRestore();
});

it("AI layout proposals cannot remove a deterministic extraction safety block", async () => {
  const store = await createPgliteStore();
  const app = await testApp({ store });
  await sessions(app).register("platform-admin", "owner-1");
  const tenantResponse = await call(app, "POST", "/v1/tenants", {
    actor: "platform-admin",
    region: "us-east-1",
    body: { name: "Proposals", homeRegion: "us-east-1", ownerActorId: "owner-1" },
  });
  expect(tenantResponse.status).toBe(201);
  const { tenantId } = (await tenantResponse.json()) as { tenantId: string };
  const entityResponse = await call(app, "POST", "/v1/entities", {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
    body: { legalName: "Proposals", functionalCurrency: "USD" },
  });
  expect(entityResponse.status).toBe(201);
  const { entityId } = (await entityResponse.json()) as { entityId: string };
  const service = createIngestionService(store, [], {
    propose: async () => null,
    proposeExtraction: async () => ({
      rows: [
        {
          label: "Cash",
          amount: "1000",
          periodLabel: "Year ended 31 December 2025",
          statementType: "balance_sheet",
        },
        {
          label: "Retained earnings",
          amount: "1000",
          periodLabel: "Year ended 31 December 2025",
          statementType: "balance_sheet",
        },
      ],
    }),
  });
  const actor = {
    actorId: "owner-1",
    tenantId,
    region: "us-east-1",
    correlationId: "proposal",
    idempotencyKey: "proposal",
    expectedVersion: null,
    verified: true,
  };
  const job = await service.upload(actor, {
    entityId,
    files: [
      {
        fileName: "unknown.csv",
        mediaType: "text/csv",
        bytes: new TextEncoder().encode("Foo,Bar\n1,2"),
      },
    ],
  });
  expect(job.status).toBe("needs_review");
  expect(
    (await service.getExceptions(actor, job.jobId, {})).exceptions.some(
      (e) => e.type === "layout_unresolved",
    ),
  ).toBe(true);
});
