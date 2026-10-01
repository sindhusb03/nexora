import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { statementPeriodCorpus } from "./fixtures/statement-period-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const corpus = statementPeriodCorpus();
const scores: Record<string, { cells: number; wrong: number; held: number }> = {};
describe("round 3B synthetic statement period goldens", () => {
  it.each(corpus)("exact values and period ends per column: $id", async (fixture) => {
    const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    const expected = fixture.ends.flatMap((end, col) =>
      end
        ? [
            ["Revenue", `${1200 + col * 100}.25`, end],
            ["Rent expense", `${200 + col * 10}.5`, end],
          ]
        : [],
    );
    const actual = parsed.cells.map((c) => [c.label, c.amount.replace(/\.50$/, ".5"), c.periodEnd]);
    scores[fixture.id] = {
      cells: fixture.cells,
      wrong: actual.filter((a) => !expected.some((e) => JSON.stringify(e) === JSON.stringify(a)))
        .length,
      held: fixture.cells - actual.length,
    };
    expect(actual.sort()).toEqual(expected.sort());
    expect(parsed.cells.every((c) => c.spanMonths === 12)).toBe(true);
    expect(parsed.issues.map((i) => i.code)).toEqual(
      fixture.ends.includes(null) ? expect.arrayContaining(["confirm_period_end"]) : [],
    );
  });
  afterAll(() => console.table(scores));
});

describe("statement period upload safety", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-periods");
  });
  it.each(corpus.filter((c) => !c.yearEnd))(
    "persists exact values or open period exceptions without posting: $id",
    async (fixture) => {
      const tenantResponse = await call(app, "POST", "/v1/tenants", {
        actor: "platform-admin",
        region: "us-east-1",
        body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-periods" },
      });
      expect(tenantResponse.status).toBe(201);
      const { tenantId } = (await tenantResponse.json()) as { tenantId: string };
      const options = { actor: "owner-periods", tenant: tenantId, region: "us-east-1" };
      const entityResponse = await call(app, "POST", "/v1/entities", {
        ...options,
        body: { legalName: fixture.id, functionalCurrency: "USD" },
      });
      const { entityId } = (await entityResponse.json()) as { entityId: string };
      const session = await sessions(app).session("owner-periods", "us-east-1", tenantId);
      if (session instanceof Response) throw new Error("Missing session");
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
      const job = (await response.json()) as { jobId: string; status: string };
      expect(job.status).toBe("needs_review");
      const valuesResponse = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
      const { values } = (await valuesResponse.json()) as {
        values: { label: string; minor: string; periodEnd: string }[];
      };
      expect(values.map((v) => [v.label, v.minor, v.periodEnd]).sort()).toEqual(
        fixture.ends
          .flatMap((end, col) =>
            end
              ? [
                  ["Revenue", `${1200 + col * 100}25`, end],
                  ["Rent expense", `${200 + col * 10}50`, end],
                ]
              : [],
          )
          .sort(),
      );
      if (fixture.ends.includes(null)) {
        const response = await call(app, "GET", `/ingestion/jobs/${job.jobId}/exceptions`, options);
        expect(await response.json()).toMatchObject({
          exceptions: expect.arrayContaining([
            expect.objectContaining({ type: "confirm_period_end", status: "open" }),
          ]),
        });
      }
      const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
      expect(await journals.json()).toMatchObject({ journals: [] });
    },
  );
});
