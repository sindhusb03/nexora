import { AnalyticalDecimal, mapLineLabel, mappingIsAutoAcceptable } from "@nexora/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectDocumentParser, type ParsedCell } from "../src/imports/document-parser.js";
import { adversarialCorpus, type Truth } from "./fixtures/adversarial-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

export function matches(actual: ParsedCell, expected: Truth): boolean {
  return (
    actual.label === expected.label &&
    new AnalyticalDecimal(actual.amount).eq(expected.amount) &&
    actual.periodStart === expected.periodStart &&
    actual.periodEnd === expected.periodEnd &&
    actual.scale === expected.scale &&
    actual.currency === expected.currency &&
    actual.statementType === expected.statementType &&
    actual.balanceKind === expected.balanceKind &&
    actual.txnDate === expected.txnDate
  );
}

it("scores independently generated families with zero wrong values and zero wrong auto-mappings", async () => {
  const totals = new Map<
    string,
    { documents: number; expected: number; correct: number; wrong: number; wrongMappings: number }
  >();
  const errors: string[] = [];
  for (const fixture of adversarialCorpus()) {
    const result = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    const score = totals.get(fixture.family) ?? {
      documents: 0,
      expected: 0,
      correct: 0,
      wrong: 0,
      wrongMappings: 0,
    };
    score.documents++;
    score.expected += fixture.cells.length;
    const remaining = [...fixture.cells];
    for (const actual of result.cells) {
      const index = remaining.findIndex((truth) => matches(actual, truth));
      if (index < 0) {
        score.wrong++;
        errors.push(
          `${fixture.id}: ${actual.label} ${actual.amount} ${actual.periodStart}/${actual.periodEnd} ${actual.scale}`,
        );
      } else {
        score.correct++;
        remaining.splice(index, 1);
      }
      if (actual.statementType === "bank") continue;
      const mapping = mapLineLabel(actual.label);
      if (
        mapping &&
        mappingIsAutoAcceptable(mapping.confidence) &&
        mapping.accountCode !== fixture.cells.find((c) => c.label === actual.label)?.accountCode
      )
        score.wrongMappings++;
    }
    if (remaining.length)
      errors.push(
        `${fixture.id}: omitted ${remaining.length}; issues ${result.issues.map((i) => i.code).join(",")}`,
      );
    totals.set(fixture.family, score);
  }
  console.table(Object.fromEntries(totals));
  for (const [family, score] of totals) {
    expect(score.wrong, errors.join("\n")).toBe(0);
    expect(score.wrongMappings, family).toBe(0);
    expect(score.correct / score.expected, errors.join("\n")).toBeGreaterThanOrEqual(0.8);
  }
});

describe("family accuracy through authenticated upload and posting", () => {
  let app: TestApp;
  let tenant: string;
  const scores: Record<
    string,
    { cells: number; correct: number; wrongValues: number; wrongAutoPosts: number }
  > = {};
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-1");
    const response = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Independent corpus", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    expect(response.status).toBe(201);
    tenant = ((await response.json()) as { tenantId: string }).tenantId;
  });
  it.each(adversarialCorpus())("$id", async (fixture) => {
    const entityResponse = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant,
      region: "us-east-1",
      body: { legalName: fixture.id, functionalCurrency: fixture.cells[0]!.currency },
    });
    expect(entityResponse.status).toBe(201);
    const entityId = ((await entityResponse.json()) as { entityId: string }).entityId;
    const session = await sessions(app).session("owner-1", "us-east-1", tenant);
    if (session instanceof Response) throw new Error("Session unavailable");
    const form = new FormData();
    form.set("entityId", entityId);
    form.set("file", new File([Buffer.from(fixture.bytes)], fixture.fileName));
    const response = await app.request("/ingestion/uploads", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": fixture.id,
      },
      body: form,
    });
    expect(response.status).toBe(201);
    const job = (await response.json()) as {
      jobId: string;
      status: string;
      counts: { exceptionsError: number };
    };
    const valueResponse = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, {
      actor: "owner-1",
      tenant,
      region: "us-east-1",
    });
    const { values } = (await valueResponse.json()) as {
      values: {
        label: string;
        minor: string | null;
        periodEnd: string;
        currency: string;
        scale: string;
        accountCode: string | null;
        mappingAccepted: boolean;
      }[];
    };
    const remaining = [...fixture.cells];
    const score = scores[fixture.family] ?? {
      cells: 0,
      correct: 0,
      wrongValues: 0,
      wrongAutoPosts: 0,
    };
    score.cells += remaining.length;
    let wrong = 0;
    for (const value of values) {
      const index = remaining.findIndex((truth) => {
        const factor = { units: "1", thousands: "1000", millions: "1000000" }[truth.scale];
        const minor = new AnalyticalDecimal(truth.amount)
          .mul(factor ?? "1")
          .mul(truth.currency === "JPY" ? "1" : "100")
          .toFixed(0);
        return (
          truth.label === value.label &&
          minor === value.minor &&
          truth.periodEnd === value.periodEnd &&
          truth.currency === value.currency &&
          truth.scale === value.scale &&
          (!value.mappingAccepted || value.accountCode === truth.accountCode)
        );
      });
      if (index < 0) wrong++;
      else {
        score.correct++;
        remaining.splice(index, 1);
      }
    }
    score.wrongValues += wrong;
    if (
      job.status === "posted" &&
      (wrong > 0 || remaining.length > 0 || job.counts.exceptionsError > 0)
    )
      score.wrongAutoPosts++;
    scores[fixture.family] = score;
    const journalsResponse = await call(app, "GET", `/v1/entities/${entityId}/journals`, {
      actor: "owner-1",
      tenant,
      region: "us-east-1",
    });
    const { journals } = (await journalsResponse.json()) as { journals: unknown[] };
    if (job.status !== "posted") expect(journals).toEqual([]);
    expect(wrong).toBe(0);
    expect(score.wrongAutoPosts).toBe(0);
    expect(values.length / fixture.cells.length).toBeGreaterThanOrEqual(0.8);
  });
  afterAll(() => {
    console.table(scores);
  });
});
