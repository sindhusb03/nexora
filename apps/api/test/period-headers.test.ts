import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticalDecimal } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { periodHeaderCorpus } from "./fixtures/period-header-corpus.js";
import { resolveStatementPeriods } from "../src/imports/period.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const scores: Record<string, { cells: number; wrong: number; held: number }> = {};
describe("round 4A authored period header goldens", () => {
  it.each(periodHeaderCorpus())(
    "exact Decimal values, starts, ends and traps: $id",
    async (fixture) => {
      const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
      const expected = fixture.periods.flatMap((period, i) =>
        period
          ? [
              ["Revenue", i === 0 ? "1478.25" : "1327.75", ...period],
              ["Rent expense", i === 0 ? "218.5" : "192.25", ...period],
            ]
          : [],
      );
      const actual = parsed.cells.map((c) => [
        c.label,
        new AnalyticalDecimal(c.amount).toFixed(),
        c.periodStart,
        c.periodEnd,
      ]);
      scores[fixture.id] = {
        cells: fixture.cells,
        wrong: actual.filter((a) => !expected.some((e) => JSON.stringify(e) === JSON.stringify(a)))
          .length,
        held: fixture.cells - actual.length,
      };
      expect(actual.sort()).toEqual(expected.sort());
      expect(parsed.cells.every((c) => c.spanMonths === 12)).toBe(true);
      expect(parsed.issues.map((i) => i.code)).toEqual(
        fixture.periods.includes(null) ? expect.arrayContaining(["confirm_period_end"]) : [],
      );
    },
  );
  afterAll(() => console.table(scores));
});

describe("period evidence safeguards", () => {
  it.each([
    "Geschäftsjahr",
    "GJ",
    "Exercice",
    "Ejercicio",
    "Esercizio",
    "Exercício",
    "Boekjaar",
    "FY",
  ])("requires year-end evidence for %s", (label) => {
    expect(resolveStatementPeriods([`${label} 2024`], "Income Statement", null)).toEqual([null]);
    expect(
      resolveStatementPeriods([`${label} 2024`], "Printed as of 31 December 2024", null),
    ).toEqual([null]);
    expect(resolveStatementPeriods([`${label} 2024`], "", { month: 6, day: 30 })[0]).toMatchObject({
      periodStart: "2023-07-01",
      periodEnd: "2024-06-30",
    });
  });
  it("keeps short and ambiguous ranges in review", () => {
    expect(
      resolveStatementPeriods(
        ["Q4 2024", "October - December 2024", "April - March 2024"],
        "",
        null,
      ),
    ).toEqual([null, null, null]);
  });
  it("holds contradictory fiscal year-end lines even with an organisation setting", () => {
    expect(
      resolveStatementPeriods(
        ["FY 2024"],
        "Fiscal year end: 30 June\nFiscal year end: 31 December",
        { month: 6, day: 30 },
      ),
    ).toEqual([null]);
  });
  it("resolves an explicit fiscal year-end line without a colon", () => {
    expect(
      resolveStatementPeriods(["FY 2024"], "Fiscal year-end 30 September", null)[0],
    ).toMatchObject({ periodStart: "2023-10-01", periodEnd: "2024-09-30" });
  });
});

describe("round 4A period upload safety", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-header");
  });
  it.each(periodHeaderCorpus())(
    "persists exact cells or open exceptions; no journals: $id",
    async (fixture) => {
      const tenantResponse = await call(app, "POST", "/v1/tenants", {
        actor: "platform-admin",
        region: "us-east-1",
        body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-header" },
      });
      expect(tenantResponse.status).toBe(201);
      const { tenantId } = (await tenantResponse.json()) as { tenantId: string };
      const options = { actor: "owner-header", tenant: tenantId, region: "us-east-1" };
      const entityResponse = await call(app, "POST", "/v1/entities", {
        ...options,
        body: { legalName: fixture.id, functionalCurrency: "USD" },
      });
      expect(entityResponse.status).toBe(201);
      const { entityId } = (await entityResponse.json()) as { entityId: string };
      const session = await sessions(app).session("owner-header", "us-east-1", tenantId);
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
        fixture.periods
          .flatMap((p, i) =>
            p
              ? [
                  ["Revenue", i === 0 ? "147825" : "132775", p[1]],
                  ["Rent expense", i === 0 ? "21850" : "19225", p[1]],
                ]
              : [],
          )
          .sort(),
      );
      if (fixture.periods.includes(null)) {
        const exceptions = await call(
          app,
          "GET",
          `/ingestion/jobs/${job.jobId}/exceptions`,
          options,
        );
        expect(await exceptions.json()).toMatchObject({
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
