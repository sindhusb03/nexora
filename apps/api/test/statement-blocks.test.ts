import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticalDecimal } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { statementBlockCorpus } from "./fixtures/statement-block-corpus.js";
import { encodeGrid } from "./fixtures/adversarial-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const scores: Record<string, { expected: number; correct: number; wrong: number; held: boolean }> =
  {};
describe("round 4C multi-block statement goldens", () => {
  it("preserves shared currency and scale above independently titled blocks", async () => {
    const bytes = encodeGrid(
      [
        ["Currency INR"],
        ["Amounts in lakhs"],
        ["Income Statement year ended 31 December 2024"],
        ["Account", "31 December 2024"],
        ["Sales", "9.01"],
        ["Balance Sheet as at 31 March 2025"],
        ["Account", "31 March 2025"],
        ["Cash", "4.05"],
      ],
      "xlsx",
      "Report",
    );
    const parsed = await selectDocumentParser("shared.xlsx", bytes).parse({
      fileName: "shared.xlsx",
      bytes,
      functionalCurrency: "USD",
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.cells.map((c) => [c.label, c.amount, c.periodEnd, c.currency, c.scale])).toEqual([
      ["Sales", "9.01", "2024-12-31", "INR", "lakhs"],
      ["Cash", "4.05", "2025-03-31", "INR", "lakhs"],
    ]);
  });
  it.each(statementBlockCorpus())(
    "exact values, periods, roles and review traps: $id",
    async (fixture) => {
      const parsed = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
      const actual = parsed.cells
        .filter((c) => c.role === "line")
        .map((c) => [
          c.label,
          new AnalyticalDecimal(c.amount).toFixed(),
          c.periodEnd,
          c.statementType,
          c.role,
        ]);
      const correct = actual.filter((a) =>
        fixture.facts.some((f) => JSON.stringify(f) === JSON.stringify(a)),
      ).length;
      scores[fixture.id] = {
        expected: fixture.facts.length,
        correct,
        wrong: actual.length - correct,
        held: !!fixture.held,
      };
      expect(actual.sort()).toEqual([...fixture.facts].sort());
      expect(parsed.issues.map((i) => i.code)).toEqual(fixture.held ? ["layout_unresolved"] : []);
      if (fixture.held) expect(parsed.cells).toEqual([]);
      const starts: Record<string, string> = {
        "2024-12-31": "2024-01-01",
        "2023-12-31": "2023-01-01",
        "2025-03-31": "2024-04-01",
      };
      expect(
        parsed.cells.every((c) => c.periodStart === starts[c.periodEnd] && c.spanMonths === 12),
      ).toBe(true);
    },
  );
  afterAll(() => console.table(scores));
});

describe("round 4C upload safeguards", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-blocks");
  });
  it.each(statementBlockCorpus())(
    "persists exact account values or holds the document, with no wrong auto-post: $id",
    async (fixture) => {
      const tenant = await call(app, "POST", "/v1/tenants", {
        actor: "platform-admin",
        region: "us-east-1",
        body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-blocks" },
      });
      const { tenantId } = (await tenant.json()) as { tenantId: string };
      const options = { actor: "owner-blocks", tenant: tenantId, region: "us-east-1" };
      const entity = await call(app, "POST", "/v1/entities", {
        ...options,
        body: { legalName: fixture.id, functionalCurrency: "USD" },
      });
      const { entityId } = (await entity.json()) as { entityId: string };
      const session = await sessions(app).session("owner-blocks", "us-east-1", tenantId);
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
      const data = (await (
        await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options)
      ).json()) as {
        values: {
          label: string;
          minor: string;
          periodEnd: string;
          statementType: string;
          role: string;
        }[];
      };
      if (fixture.held) {
        expect(data.values).toEqual([]);
        expect(
          await (await call(app, "GET", `/ingestion/jobs/${job.jobId}/exceptions`, options)).json(),
        ).toMatchObject({
          exceptions: expect.arrayContaining([
            expect.objectContaining({ type: "layout_unresolved", status: "open" }),
          ]),
        });
      } else {
        expect(
          data.values
            .filter((v) => v.role === "line")
            .map((v) => [v.label, v.minor, v.periodEnd, v.statementType, v.role])
            .sort(),
        ).toEqual(
          fixture.facts
            .map(([label, amount, end, type, role]) => [
              label,
              new AnalyticalDecimal(amount).mul(100).toFixed(0),
              end,
              type,
              role,
            ])
            .sort(),
        );
      }
      expect(
        await (await call(app, "GET", `/v1/entities/${entityId}/journals`, options)).json(),
      ).toMatchObject({ journals: [] });
    },
  );
});
