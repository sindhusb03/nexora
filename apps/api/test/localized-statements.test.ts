import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticalDecimal, mapLineLabel, statementRole } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { decimalToMinor } from "../src/ingestion/service.js";
import { localizedCorpus } from "./fixtures/localized-corpus.js";
import { encodeGrid } from "./fixtures/adversarial-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";
import { parseStatementPdf } from "../src/imports/statement-pdf.js";
import { resolveStatementPeriods } from "../src/imports/period.js";
import { writeXlsx } from "../src/imports/xlsx-write.js";

const scores: Record<string, { cells: number; wrong: number; held: number }> = {};
describe("round 3C localized golden statements", () => {
  it.each(localizedCorpus())("exact scaled Decimal values and periods: $id", async (fixture) => {
    const result = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    const actual = result.cells.map((c) => [
      c.label,
      new AnalyticalDecimal(decimalToMinor(c.amount, c.currency!, c.scale, false))
        .div(c.currency === "JPY" ? 1 : 100)
        .toFixed(),
      c.periodEnd,
      mapLineLabel(c.label)?.accountCode,
    ]);
    const expected = fixture.labels.map((label, i) => [
      label,
      fixture.scaled[i],
      "2025-03-31",
      fixture.codes[i],
    ]);
    scores[fixture.id] = {
      cells: 3,
      wrong: actual.filter((a) => !expected.some((e) => JSON.stringify(a) === JSON.stringify(e)))
        .length,
      held: 3 - actual.length,
    };
    expect(actual).toEqual(expected);
    expect(result.issues).toEqual([]);
    expect(result.cells.every((c) => c.scale === fixture.scale && c.spanMonths === 12)).toBe(true);
    for (const c of result.cells)
      if (mapLineLabel(c.label)?.accountCode === "net_income")
        expect(statementRole(c.label)).toBe("total");
  });
  it.each([
    { id: "mixed-conventions", unit: "Amounts in units EUR", amounts: ["1234,5", "1234.5"] },
    { id: "ambiguous-separator", unit: "Amounts in units EUR", amounts: ["1,234", "2,345"] },
    { id: "unknown-scale", unit: "Amounts in zillions EUR", amounts: ["1234.5", "234.5"] },
    {
      id: "conflicting-scale",
      unit: "en euros / en milliers d'euros EUR",
      amounts: ["1234,5", "234,5"],
    },
  ])("holds the entire document: $id", async (fixture) => {
    const bytes = encodeGrid(
      [
        ["Compte de résultat"],
        [fixture.unit],
        ["Account", "Year ended 31 March 2025"],
        ["Chiffre d’affaires", fixture.amounts[0]!],
        ["Charges de personnel", fixture.amounts[1]!],
      ],
      "xlsx",
      "Report",
    );
    const result = await selectDocumentParser("trap.xlsx", bytes).parse({
      fileName: "trap.xlsx",
      bytes,
    });
    scores[fixture.id] = { cells: 2, wrong: result.cells.length, held: 2 - result.cells.length };
    expect(result.cells).toEqual([]);
    expect(result.issues.some((i) => i.code === "layout_unresolved")).toBe(true);
  });
  it("keeps unknown-language and qualified labels for review", async () => {
    const labels = ["Tuntematon erä", "Chiffre d’affaires différé", "売上高調整"];
    const bytes = encodeGrid(
      [
        ["Compte de résultat EUR en euros"],
        ["Account", "Year ended 31 March 2025"],
        ...labels.map((l) => [l, "12,5"]),
      ],
      "csv",
      "Report",
    );
    const result = await selectDocumentParser("unknown.csv", bytes).parse({
      fileName: "unknown.csv",
      bytes,
    });
    expect(result.cells.map((c) => c.label)).toEqual(labels);
    expect(
      result.cells.map((c) => [new AnalyticalDecimal(c.amount).toFixed(), c.periodEnd, c.scale]),
    ).toEqual(labels.map(() => ["12.5", "2025-03-31", "units"]));
    for (const label of labels) expect(mapLineLabel(label)).toBeNull();
    scores["unknown-labels"] = { cells: 3, wrong: 0, held: 3 };
  });
  afterAll(() => console.table(scores));
  it.each(["令和7年3月期", "2025年3月期", "当事業年度\n（2025年3月31日）"])(
    "reads Japanese fiscal header %s",
    async (header) => {
      const bytes = encodeGrid(
        [["損益計算書 JPY 千円"], ["科目", header], ["売上高", "1234"]],
        "xlsx",
        "Report",
      );
      const result = await selectDocumentParser("period.xlsx", bytes).parse({
        fileName: "period.xlsx",
        bytes,
      });
      expect(result.cells.map((c) => [c.amount, c.periodEnd, c.spanMonths])).toEqual([
        ["1234", "2025-03-31", 12],
      ]);
    },
  );
  it.each(["xlsx", "csv", "pdf"] as const)(
    "never books dated note, gross or accumulated columns in %s",
    async (format) => {
      const bytes = encodeGrid(
        [
          ["Balance sheet EUR"],
          ["Amounts in units"],
          ["Account", "Notes", "Gross", "Accumulated", "Year ended"],
          ["", "31 March 2025", "31 March 2025", "31 March 2025", "31 March 2025"],
          ["Fixed assets", "87", "4500.50", "1200.25", "3300.25"],
        ],
        format,
        "Report",
      );
      const result = await selectDocumentParser(`columns.${format}`, bytes).parse({
        fileName: `columns.${format}`,
        bytes,
      });
      expect(result.cells.map((c) => [c.label, c.amount, c.periodEnd])).toEqual([
        ["Fixed assets", "3300.25", "2025-03-31"],
      ]);
    },
  );
  it.each([
    "en milliers d'euros",
    "en euros",
    "TEUR",
    "in Mio. EUR",
    "miles de euros",
    "単位：千円",
    "単位：百万円",
  ])("identifies denomination from a localized unit declaration %s", async (unit) => {
    const bytes = encodeGrid(
      [["Income statement"], [unit], ["Account", "Year ended 31 March 2025"], ["Revenue", "1234"]],
      "xlsx",
      "Report",
    );
    const result = await selectDocumentParser("units.xlsx", bytes).parse({
      fileName: "units.xlsx",
      bytes,
    });
    expect(result.cells[0]?.currency).toBe(unit.includes("円") ? "JPY" : "EUR");
  });
  it("holds mixed conventions across sheets before posting", async () => {
    const bytes = writeXlsx(
      ["1234,5", "1234.5"].map((amount, i) => ({
        name: `Income ${i}`,
        cells: [
          ["Income statement EUR"],
          ["Amounts in units"],
          ["Account", "Year ended 31 March 2025"],
          ["Revenue", amount],
        ].flatMap((row, r) =>
          row.map((value, c) => ({ row: r + 1, col: c + 1, value, kind: "string" as const })),
        ),
      })),
    );
    const result = await selectDocumentParser("mixed.xlsx", bytes).parse({
      fileName: "mixed.xlsx",
      bytes,
    });
    expect(result.cells).toEqual([]);
    expect(result.issues.some((i) => i.code === "layout_unresolved")).toBe(true);
  });
});

describe("localized upload safety", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-localized");
  });
  it.each(["unknown-label", "mixed-conventions", "unknown-scale"])(
    "persists an open exception and no journals for %s",
    async (id) => {
      const tenant = await call(app, "POST", "/v1/tenants", {
        actor: "platform-admin",
        region: "us-east-1",
        body: { name: id, homeRegion: "us-east-1", ownerActorId: "owner-localized" },
      });
      const { tenantId } = (await tenant.json()) as { tenantId: string };
      const options = { actor: "owner-localized", tenant: tenantId, region: "us-east-1" };
      const entity = await call(app, "POST", "/v1/entities", {
        ...options,
        body: { legalName: id, functionalCurrency: "EUR" },
      });
      const { entityId } = (await entity.json()) as { entityId: string };
      const session = await sessions(app).session("owner-localized", "us-east-1", tenantId);
      if (session instanceof Response) throw new Error("Missing session");
      const bytes = encodeGrid(
        [
          ["Compte de résultat EUR"],
          [id === "unknown-scale" ? "Amounts in zillions" : "en euros"],
          ["Account", "Year ended 31 March 2025"],
          [id === "unknown-label" ? "Tuntematon erä" : "Chiffre d’affaires", "1234,5"],
          ["Charges de personnel", id === "mixed-conventions" ? "234.5" : "234,5"],
        ],
        "xlsx",
        "Report",
      );
      const form = new FormData();
      form.set("entityId", entityId);
      form.set("file", new File([Buffer.from(bytes)], `${id}.xlsx`));
      const response = await app.request("/ingestion/uploads", {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "idempotency-key": id,
        },
        body: form,
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as { jobId: string; status: string };
      expect(job.status).toBe("needs_review");
      const exceptions = await call(app, "GET", `/ingestion/jobs/${job.jobId}/exceptions`, options);
      expect(await exceptions.json()).toMatchObject({
        exceptions: expect.arrayContaining([
          expect.objectContaining({
            type: id === "unknown-label" ? "mapping_low_confidence" : "layout_unresolved",
            status: "open",
          }),
        ]),
      });
      const values = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
      const data = (await values.json()) as {
        values: {
          label: string;
          mappingAccepted: boolean;
          mappingConfidence: string | null;
          mappingMethod: string | null;
        }[];
      };
      if (id === "unknown-label") {
        expect(data.values.find((v) => v.label === "Tuntematon erä")).toMatchObject({
          mappingAccepted: false,
          mappingMethod: "ai",
        });
        expect(
          new AnalyticalDecimal(
            data.values.find((v) => v.label === "Tuntematon erä")!.mappingConfidence ?? "0",
          ).lt("0.95"),
        ).toBe(true);
        expect(mapLineLabel("Tuntematon erä")).toBeNull();
      } else expect(data.values).toEqual([]);
      const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
      expect(await journals.json()).toMatchObject({ journals: [] });
    },
  );
  it.each(localizedCorpus())(
    "persists scaled goldens once without posting an incomplete statement: $id",
    async (fixture) => {
      const tenant = await call(app, "POST", "/v1/tenants", {
        actor: "platform-admin",
        region: "us-east-1",
        body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-localized" },
      });
      const { tenantId } = (await tenant.json()) as { tenantId: string };
      const options = { actor: "owner-localized", tenant: tenantId, region: "us-east-1" };
      const currency = fixture.id.startsWith("ja-")
        ? "JPY"
        : fixture.id.startsWith("in-")
          ? "INR"
          : "EUR";
      const entity = await call(app, "POST", "/v1/entities", {
        ...options,
        body: { legalName: fixture.id, functionalCurrency: currency },
      });
      const { entityId } = (await entity.json()) as { entityId: string };
      const session = await sessions(app).session("owner-localized", "us-east-1", tenantId);
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
      const values = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
      const data = (await values.json()) as {
        values: { label: string; minor: string; periodEnd: string; accountCode: string }[];
      };
      expect(
        data.values
          .map((c) => [
            c.label,
            new AnalyticalDecimal(c.minor).div(currency === "JPY" ? 1 : 100).toFixed(),
            c.periodEnd,
            c.accountCode,
          ])
          .sort(),
      ).toEqual(
        fixture.labels
          .map((label, i) => [label, fixture.scaled[i], "2025-03-31", fixture.codes[i]])
          .sort(),
      );
      const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
      expect(await journals.json()).toMatchObject({ journals: [] });
    },
  );
});

function textWorkbook(rows: string[][]): Uint8Array {
  return writeXlsx([
    {
      name: "Report",
      cells: rows.flatMap((row, r) =>
        row.map((value, c) => ({ row: r + 1, col: c + 1, value, kind: "string" as const })),
      ),
    },
  ]);
}

const uncertainPeriods = [
  {
    id: "portuguese-interim",
    format: "pdf" as const,
    rows: [
      ["Demonstração dos resultados por naturezas"],
      ["Período findo em 30 de junho de 2024 (montantes expressos em euros)"],
      ["Account", "2024", "2023"],
      ["Revenue", "2976247", "2000000"],
    ],
  },
  ...["30.06.2024", "30. Juni 2024"].map((date) => ({
    id: `swiss-interim-${date}`,
    format: "xlsx" as const,
    rows: [
      [`Erfolgsrechnung per ${date}`, "CHF"],
      ["Account", "Geschäftsjahr 2024", "Geschäftsjahr 2023"],
      ["Revenue", "3000000.00", "2500000.00"],
    ],
  })),
  {
    id: "spanish-undated-neto",
    format: "xlsx" as const,
    rows: [
      ["Balance de situación — Activo", "EUR"],
      ["ACTIVO", "Neto 2024", "Neto 2023"],
      ["Fixed assets", "3300.25", "3000.25"],
    ],
  },
];

describe("uncertain localized periods", () => {
  it.each(uncertainPeriods)("holds period values for review: $id", async (fixture) => {
    const bytes = encodeGrid(fixture.rows, fixture.format, "Report");
    const fileName = `${fixture.id}.${fixture.format}`;
    const result = await selectDocumentParser(fileName, bytes).parse({ fileName, bytes });
    expect(result.cells).toEqual([]);
    if (fixture.id === "portuguese-interim") {
      // The PDF path raises a different review message for this case; no values are saved.
      expect(result.issues.length).toBeGreaterThan(0);
    } else {
      expect(result.issues.some((i) => i.message.includes("Confirm period end"))).toBe(true);
    }
    // Neither an organization calendar nor an annual header can supply missing title evidence.
    expect(
      resolveStatementPeriods(
        fixture.rows.at(-2)!.slice(1),
        fixture.rows.slice(0, -2).flat().join("\n"),
        { month: 12, day: 31 },
      ),
    ).toEqual([null, null]);
  });

  it.each(uncertainPeriods)("stores no values or auto-posts: $id", async (fixture) => {
    const app = await testApp();
    await sessions(app).register("platform-admin", "owner-period");
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-period" },
    });
    expect(tenant.status).toBe(201);
    const { tenantId } = (await tenant.json()) as { tenantId: string };
    const options = { actor: "owner-period", tenant: tenantId, region: "us-east-1" };
    const entity = await call(app, "POST", "/v1/entities", {
      ...options,
      body: {
        legalName: fixture.id,
        functionalCurrency: fixture.id.startsWith("swiss") ? "CHF" : "EUR",
      },
    });
    expect(entity.status).toBe(201);
    const { entityId } = (await entity.json()) as { entityId: string };
    const session = await sessions(app).session("owner-period", "us-east-1", tenantId);
    if (session instanceof Response) throw new Error("Missing session");
    const form = new FormData();
    form.set("entityId", entityId);
    form.set(
      "file",
      new File(
        [Buffer.from(encodeGrid(fixture.rows, fixture.format, "Report"))],
        `${fixture.id}.${fixture.format}`,
      ),
    );
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
    const values = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
    expect(await values.json()).toMatchObject({ values: [] });
    const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
    expect(await journals.json()).toMatchObject({ journals: [] });
  });
});

describe("held-out localized statement semantics", () => {
  it("resolves Neto years only from an explicit as-at title date", () => {
    const labels = ["Neto 2024", "Neto 2023"];
    expect(
      resolveStatementPeriods(
        labels,
        "Balance de situación al 30 de junio de 2024 — Activo",
        null,
      ).map((p) => p?.periodEnd),
    ).toEqual(["2024-06-30", "2023-06-30"]);
    expect(
      resolveStatementPeriods(labels, "Balance de situación — Activo", { month: 12, day: 31 }),
    ).toEqual([null, null]);
  });
  it("reads Swiss German fiscal years and text amounts with apostrophe thousands", async () => {
    const bytes = textWorkbook([
      ["Erfolgsrechnung per 31. Dezember 2024", "CHF"],
      ["Account", "Geschäftsjahr 2024", "Geschäftsjahr 2023"],
      ["Revenue", "3'000'000.00", "2'500'000.00"],
      ["Expense", "-2'217'196.88", "-2'000'000.00"],
    ]);
    const result = await selectDocumentParser("swiss.xlsx", bytes).parse({
      fileName: "swiss.xlsx",
      bytes,
    });
    expect(result.issues).toEqual([]);
    expect(result.cells.every((c) => c.scale === "units" && c.currency === "CHF")).toBe(true);
    expect(
      result.cells.map((c) => [
        c.label,
        new AnalyticalDecimal(c.amount).toFixed(),
        c.periodEnd,
        c.statementType,
      ]),
    ).toEqual([
      ["Revenue", "3000000", "2024-12-31", "income_statement"],
      ["Revenue", "2500000", "2023-12-31", "income_statement"],
      ["Expense", "-2217196.88", "2024-12-31", "income_statement"],
      ["Expense", "-2000000", "2023-12-31", "income_statement"],
    ]);
  });
  it("reads Portuguese text PDF fiscal years, spaced thousands and parentheses", () => {
    const rows = [
      ["Demonstração dos resultados por naturezas"],
      ["Período findo em 31 de dezembro de 2024 (montantes expressos em euros)"],
      ["Account", "Exercício 2024", "Exercício 2023"],
      ["Revenue", "2 976 247", "2 000 000"],
      ["Expense", "(987 630)", "(800 000)"],
    ];
    const lines = rows.map((row, r) => ({
      page: 1,
      y: 700 - r * 20,
      items: row.map((text, c) => ({ text, x: [30, 300, 450][c]!, y: 700 - r * 20 })),
    }));
    const result = parseStatementPdf(
      { pages: 1, lines, textItems: lines.reduce((n, l) => n + l.items.length, 0) },
      "report.pdf",
    );
    expect(result.layoutUnresolved).toBe(false);
    expect(result.droppedAmounts).toEqual([]);
    expect(result.sheets).toHaveLength(1);
    const sheet = result.sheets[0]!;
    const periods = resolveStatementPeriods(
      sheet.periods.map((p) => p.label),
      sheet.periodContext!,
      null,
    );
    expect(periods.map((p) => p?.periodEnd)).toEqual(["2024-12-31", "2023-12-31"]);
    expect(sheet.statementType).toBe("income_statement");
    expect(sheet.lines.flatMap((l) => l.values.map((v) => [l.label, v.amount]))).toEqual([
      ["Revenue", "2976247"],
      ["Revenue", "2000000"],
      ["Expense", "-987630"],
      ["Expense", "-800000"],
    ]);
  });
  it("commits only Spanish Neto period columns, excluding gross and depreciation", async () => {
    const bytes = textWorkbook([
      ["Balance de situación al 31 de diciembre de 2024 — Activo", "EUR"],
      ["ACTIVO", "Bruto", "Amortización y deterioro", "Neto 2024", "Neto 2023"],
      ["Fixed assets", "4500.50", "1200.25", "3300.25", "3000.25"],
    ]);
    const result = await selectDocumentParser("spanish.xlsx", bytes).parse({
      fileName: "spanish.xlsx",
      bytes,
    });
    expect(result.issues).toEqual([]);
    expect(result.cells.map((c) => [c.label, c.amount, c.periodEnd, c.statementType])).toEqual([
      ["Fixed assets", "3300.25", "2024-12-31", "balance_sheet"],
      ["Fixed assets", "3000.25", "2023-12-31", "balance_sheet"],
    ]);
  });
  it("uses a Korean explicit range for a single current fiscal-period column", async () => {
    const bytes = textWorkbook([
      ["손익계산서"],
      ["제 12 기  2024년 1월 1일부터 2024년 12월 31일까지"],
      ["(단위: 원)"],
      ["Account", "제 12 (당) 기"],
      ["Revenue", "2976247"],
      ["Expense", "-987630"],
    ]);
    const result = await selectDocumentParser("korean.xlsx", bytes).parse({
      fileName: "korean.xlsx",
      bytes,
    });
    expect(result.issues).toEqual([]);
    expect(
      result.cells.map((c) => [
        c.label,
        c.amount,
        c.periodEnd,
        c.spanMonths,
        c.currency,
        c.statementType,
      ]),
    ).toEqual([
      ["Revenue", "2976247", "2024-12-31", 12, "KRW", "income_statement"],
      ["Expense", "-987630", "2024-12-31", 12, "KRW", "income_statement"],
    ]);
  });
});
