import { beforeAll, describe, expect, it } from "vitest";
import { AnalyticalDecimal } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { parseBankText } from "../src/imports/bank-tabular.js";
import { bankValueCorpus } from "./fixtures/bank-value-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const conflictText = [
  "Currency: GBP",
  "Date,Description,Amount,Balance",
  ",Opening balance,,2500.00",
  "2024-12-13,Income,1450.00,3950.00",
  "2024-12-14,Water,-92.10,3857.90",
  "2024-12-15,Fee,-45.00,3712.90",
  ",Closing balance,,3812.90",
].join("\n");
const consistentRunningText = [
  "Currency: GBP",
  "Date,Description,Amount,Balance",
  ",Opening balance,,5120.00",
  "2024-12-13,Income,2200.00,7320.00",
  "2024-12-14,Water,-118.40,7201.60",
  "2024-12-15,Fee,-72.00,7129.60",
  ",Closing balance,,7379.60",
].join("\n");
const corpus = [
  ...bankValueCorpus(),
  {
    id: "labelled-closing-conflict",
    fileName: "conflict.csv",
    bytes: new TextEncoder().encode(conflictText),
    currency: "GBP",
    issue: "balance_mismatch" as const,
    facts: [
      ["Opening balance", "2500", null],
      ["Closing balance", "3812.9", null],
      ["Income", "1450", "2024-12-13"],
      ["Water", "-92.1", "2024-12-14"],
      ["Fee", "-45", "2024-12-15"],
    ] as [string, string, string | null][],
  },
  {
    id: "consistent-running-closing-conflict",
    fileName: "consistent-running-conflict.csv",
    bytes: new TextEncoder().encode(consistentRunningText),
    currency: "GBP",
    issue: "balance_mismatch" as const,
    facts: [
      ["Opening balance", "5120", null],
      ["Income", "2200", "2024-12-13"],
      ["Water", "-118.4", "2024-12-14"],
      ["Fee", "-72", "2024-12-15"],
    ] as [string, string, string | null][],
  },
];
const inferredClosing = new Set([
  "alder-oldest-types",
  "alder-oldest-dr-cr",
  "alder-newest-types",
  "alder-newest-dr-cr",
  "alder-no-opening",
  "summary-word-description",
  "numeric-xlsx",
]);
describe("bank row classification and balance safety", () => {
  it("keeps a non-reconciling labelled closing in a Debit/Credit CSV without running balances", () => {
    const result = parseBankText(
      [
        "Currency: GBP",
        "Date,Description,Debit,Credit",
        ",Opening balance,500.00,",
        "2024-12-13,Purchase,10.00,",
        "2024-12-14,Fee,5.00,",
        ",Closing balance,480.00,",
      ].join("\n"),
    );
    expect(result.bank?.opening).toBe("500.00");
    expect(result.bank?.closing).toBe("480.00");
    expect(result.bank?.transactions.map((t) => t.amount)).toEqual(["-10.00", "-5.00"]);
    expect(result.issues.map((i) => i.code)).toContain("balance_mismatch");
  });
  it("keeps a non-reconciling labelled closing in a narrative statement", () => {
    const result = parseBankText(
      [
        "Currency: GBP",
        "Period 2024-12-01 to 2024-12-31",
        "Opening balance 500.00",
        "2024-12-13 Purchase -10.00",
        "2024-12-14 Fee -5.00",
        "Closing balance 480.00",
      ].join("\n"),
    );
    expect(result.bank?.opening).toBe("500.00");
    expect(result.bank?.closing).toBe("480.00");
    expect(result.bank?.transactions.map((t) => t.amount)).toEqual(["-10.00", "-5.00"]);
    expect(result.issues.map((i) => i.code)).toContain("balance_mismatch");
  });
  it("keeps a reconciling labelled closing and sends a running-balance conflict to review", () => {
    const result = parseBankText(conflictText);
    expect(result.bank?.opening).toBe("2500.00");
    expect(result.bank?.closing).toBe("3812.90");
    expect(result.bank?.transactions.map((t) => t.amount)).toEqual(["1450.00", "-92.10", "-45.00"]);
    expect(result.issues.map((i) => i.code)).toContain("balance_mismatch");
  });
  it("quarantines a labelled closing that conflicts with consistent running balances", () => {
    const result = parseBankText(consistentRunningText);
    expect(result.bank?.opening).toBe("5120.00");
    expect(result.bank?.closing).toBeNull();
    expect(result.bank?.transactions.map((t) => t.amount)).toEqual([
      "2200.00",
      "-118.40",
      "-72.00",
    ]);
    expect(result.issues.map((i) => i.code)).toContain("balance_mismatch");
  });
  it.each(corpus)("exact amount/date/direction/currency or review: $id", async (fixture) => {
    const result = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    const actual = result.cells.map((c) => [
      c.label,
      new AnalyticalDecimal(c.amount).toFixed(),
      c.txnDate,
    ]);
    if (fixture.issue) expect(result.issues.map((i) => i.code)).toContain(fixture.issue);
    else expect(result.issues).toEqual([]);
    expect(actual).toEqual(
      fixture.facts.filter(
        ([label]) => label !== "Closing balance" || !inferredClosing.has(fixture.id),
      ),
    );
    for (const [index, cell] of result.cells.entries()) {
      expect(cell.currency).toBe(fixture.currency);
      expect(new AnalyticalDecimal(cell.amount).isNegative()).toBe(
        new AnalyticalDecimal(
          fixture.facts.filter(
            ([label]) => label !== "Closing balance" || !inferredClosing.has(fixture.id),
          )[index]![1],
        ).isNegative(),
      );
      expect(cell.statementType).toBe("bank");
      expect(cell.rawText).not.toBe("");
    }
  });
});

describe("bank stored value regressions", () => {
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
      values: { label: string; minor: string | null; currency: string; periodKey: string }[];
    };
    expect(values.map((v) => [v.label, v.minor, v.currency])).toEqual(
      fixture.facts
        .filter(([label]) => label !== "Closing balance" || !inferredClosing.has(fixture.id))
        .map(([label, amount]) => [
          label,
          new AnalyticalDecimal(amount).mul(fixture.currency === "JPY" ? "1" : "100").toFixed(0),
          fixture.currency,
        ]),
    );
    expect(
      values.filter((v) => !/^(Opening|Closing) balance$/.test(v.label)).map((v) => v.periodKey),
    ).toEqual(fixture.facts.filter(([, , date]) => date !== null).map(([, , date]) => date));
    const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
    expect(await journals.json()).toMatchObject({ journals: [] });
  });
});
