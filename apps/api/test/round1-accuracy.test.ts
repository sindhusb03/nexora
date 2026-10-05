import { beforeAll, afterAll, expect, it } from "vitest";
import { call, sessions, testApp, type TestApp } from "./harness.js";
import { round1Corpus } from "./fixtures/round1-corpus.js";

let app: TestApp;
const inferredClosing = new Set([
  "bank-india-0",
  "bank-india-1",
  "bank-india-2",
  "fees-0",
  "fees-1",
  "fees-2",
  "row-currency-EUR",
  "row-currency-AUD",
  "serial-bank-0",
  "serial-bank-1",
]);
const scores: Record<
  string,
  { cells: number; correct: number; wrongValues: number; wrongAutoPosts: number }
> = {};
beforeAll(async () => {
  app = await testApp();
  await sessions(app).register("platform-admin", "owner-1");
});

it.each(round1Corpus())("HTTP round 1: $id (fresh tenant, no FY setting)", async (fixture) => {
  const tenantResponse = await call(app, "POST", "/v1/tenants", {
    actor: "platform-admin",
    region: "us-east-1",
    body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-1" },
  });
  expect(tenantResponse.status).toBe(201);
  const { tenantId } = (await tenantResponse.json()) as { tenantId: string };
  const entityResponse = await call(app, "POST", "/v1/entities", {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
    body: { legalName: fixture.id, functionalCurrency: fixture.functionalCurrency },
  });
  expect(entityResponse.status).toBe(201);
  const { entityId } = (await entityResponse.json()) as { entityId: string };
  const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
  if (session instanceof Response) throw new Error("Missing session");
  const form = new FormData();
  form.set("entityId", entityId);
  form.set("file", new File([Buffer.from(fixture.bytes)], fixture.fileName));
  const uploaded = await app.request("/ingestion/uploads", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "idempotency-key": fixture.id,
    },
    body: form,
  });
  expect(uploaded.status).toBe(201);
  const job = (await uploaded.json()) as { jobId: string; status: string };
  const options = { actor: "owner-1", tenant: tenantId, region: "us-east-1" };
  const response = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
  expect(response.status).toBe(200);
  const { values } = (await response.json()) as {
    values: {
      label: string;
      minor: string | null;
      currency: string;
      periodEnd: string;
      periodKey: string;
    }[];
  };
  const remaining = fixture.expected.filter(
    ({ label }) => label !== "Closing balance" || !inferredClosing.has(fixture.id),
  );
  const score = scores[fixture.family] ?? {
    cells: 0,
    correct: 0,
    wrongValues: 0,
    wrongAutoPosts: 0,
  };
  score.cells += remaining.length;
  for (const value of values) {
    const index = remaining.findIndex(
      (e) =>
        e.label === value.label &&
        e.minor === value.minor &&
        e.currency === value.currency &&
        e.end === value.periodEnd &&
        (!e.date || e.date === value.periodKey),
    );
    if (index < 0) score.wrongValues++;
    else {
      score.correct++;
      remaining.splice(index, 1);
    }
  }
  // These deliberately partial documents never authorize a balanced ledger package.
  if (job.status === "posted") score.wrongAutoPosts++;
  scores[fixture.family] = score;
  expect(score.wrongValues, JSON.stringify(values)).toBe(0);
  expect(remaining).toEqual([]);
  expect(score.wrongAutoPosts).toBe(0);
  const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
  expect(await journals.json()).toMatchObject({ journals: [] });
  if (!fixture.expected.length) expect(job.status).toBe("needs_review");
});

afterAll(() => {
  console.table(scores);
});
