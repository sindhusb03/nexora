import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticalDecimal } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { bankRound3aCorpus } from "./fixtures/bank-round3a-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const corpus = bankRound3aCorpus();
const scores: Record<
  string,
  { cells: number; correct: number; wrong: number; reviewHeld: number }
> = {};
describe("round 3A synthetic bank goldens", () => {
  it.each(corpus)("exact amount/date/direction/currency or review: $id", async (fixture) => {
    const result = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    const actual = result.cells.map((c) => [
      c.label,
      new AnalyticalDecimal(c.amount).toFixed(),
      c.txnDate,
    ]);
    const correct = actual.filter((a) =>
      fixture.facts.some((f) => JSON.stringify(f) === JSON.stringify(a)),
    ).length;
    scores[fixture.id] = {
      cells: fixture.facts.length,
      correct,
      wrong: actual.length - correct,
      reviewHeld: Number(result.issues.length > 0),
    };
    if (fixture.issue) expect(result.issues.map((i) => i.code)).toContain(fixture.issue);
    else expect(result.issues).toEqual([]);
    expect(actual).toEqual(fixture.facts);
    for (const [index, cell] of result.cells.entries()) {
      expect(cell.currency).toBe(fixture.currency);
      expect(new AnalyticalDecimal(cell.amount).isNegative()).toBe(
        new AnalyticalDecimal(fixture.facts[index]![1]).isNegative(),
      );
      expect(cell.statementType).toBe("bank");
      expect(cell.rawText).not.toBe("");
      if (fixture.fileName.endsWith(".pdf")) expect(cell.page).toBeGreaterThan(0);
    }
  });
  afterAll(() => console.table(scores));
});

describe("bank uploads preserve values and traps persist open exceptions without auto-posts", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-1");
  });
  it.each(corpus)("upload safety: $id", async (fixture) => {
    const response = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    expect(response.status).toBe(201);
    const { tenantId } = (await response.json()) as { tenantId: string };
    const options = { actor: "owner-1", tenant: tenantId, region: "us-east-1" };
    const entityResponse = await call(app, "POST", "/v1/entities", {
      ...options,
      body: { legalName: fixture.id, functionalCurrency: fixture.currency },
    });
    expect(entityResponse.status).toBe(201);
    const { entityId } = (await entityResponse.json()) as { entityId: string };
    const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
    if (session instanceof Response) throw new Error("Missing session");
    const form = new FormData();
    form.set("entityId", entityId);
    form.set("file", new File([Buffer.from(fixture.bytes)], fixture.fileName));
    const upload = await app.request("/ingestion/uploads", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": fixture.id,
      },
      body: form,
    });
    expect(upload.status).toBe(201);
    const job = (await upload.json()) as { jobId: string; status: string };
    expect(job.status).toBe("needs_review");
    const exceptions = await call(app, "GET", `/ingestion/jobs/${job.jobId}/exceptions`, options);
    if (fixture.issue)
      expect(await exceptions.json()).toMatchObject({
        exceptions: expect.arrayContaining([
          expect.objectContaining({ type: fixture.issue, status: "open" }),
        ]),
      });
    const valuesResponse = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
    const { values } = (await valuesResponse.json()) as {
      values: { label: string; minor: string; currency: string }[];
    };
    expect(values.map((v) => [v.label, v.minor, v.currency])).toEqual(
      fixture.facts.map(([label, amount]) => [
        label,
        new AnalyticalDecimal(amount).mul(fixture.currency === "JPY" ? "1" : "100").toFixed(0),
        fixture.currency,
      ]),
    );
    const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
    expect(await journals.json()).toMatchObject({ journals: [] });
  });
});
