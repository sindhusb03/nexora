import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { extractPdfText, parseBankStatement, type PdfLine } from "../src/imports/bank-pdf.js";
import {
  excelNumberToDecimal,
  printedAmountToDecimal,
  statementAmountToDecimal,
  trimBinaryNoise,
} from "../src/imports/decimal-text.js";
import { parseStatementCsv } from "../src/imports/statement-csv.js";
import { parseStatementPdf } from "../src/imports/statement-pdf.js";
import { parseStatementSheet, parseStatementWorkbook } from "../src/imports/statement-xlsx.js";
import { readWorkbook, type SheetCell } from "../src/imports/xlsx.js";
import { call, sessions, testApp } from "./harness.js";

describe("decimal text", () => {
  it("rounds stored Excel doubles to the 15 digits Excel displays", () => {
    expect(excelNumberToDecimal("8798.4699999999993")).toBe("8798.47");
    expect(excelNumberToDecimal("42576694.910000004")).toBe("42576694.91");
    expect(excelNumberToDecimal("-5238.2299999999996")).toBe("-5238.23");
    expect(excelNumberToDecimal("0")).toBe("0");
    expect(excelNumberToDecimal("1E+3")).toBe("1000");
    expect(excelNumberToDecimal("-5.6843418860808015E-14")).toBe(
      "-0.0000000000000568434188608080".replace(/0+$/, ""),
    );
    expect(excelNumberToDecimal("12abc")).toBeNull();
  });

  it("trims binary residue only after a run of zeros or nines", () => {
    expect(trimBinaryNoise("938349.170000002")).toBe("938349.17");
    expect(trimBinaryNoise("1237855.2999999")).toBe("1237855.3");
    expect(trimBinaryNoise("-0.0000000000000568434188608")).toBe("0");
    expect(trimBinaryNoise("10.125")).toBe("10.125");
    expect(trimBinaryNoise("99.999999")).toBe("100");
    expect(trimBinaryNoise("99.99999")).toBe("99.99999");
  });

  it("reads printed bank amounts with exactly two decimals", () => {
    expect(printedAmountToDecimal("$1,024.46")).toBe("1024.46");
    expect(printedAmountToDecimal("0.50")).toBe("0.50");
    expect(printedAmountToDecimal("1,02.4")).toBeNull();
    expect(printedAmountToDecimal("12.5")).toBeNull();
  });

  it("reads statement amounts, including whole dollars, and refuses a bare year", () => {
    expect(statementAmountToDecimal("733,447")).toBe("733447");
    expect(statementAmountToDecimal("(88,988)")).toBe("-88988");
    expect(statementAmountToDecimal("119,668.99")).toBe("119668.99");
    expect(statementAmountToDecimal("-0-")).toBe("0");
    expect(statementAmountToDecimal("2024")).toBeNull();
    expect(statementAmountToDecimal("12")).toBeNull();
  });
});

function line(page: number, y: number, ...items: [number, string][]): PdfLine {
  return { page, y, items: items.map(([x, text]) => ({ x, text })) };
}

describe("bank statement lines", () => {
  const lines: PdfLine[] = [
    line(1, 750, [472, "30 de noviembre de 2024"]),
    line(1, 728, [473, "31 de diciembre de 2024"]),
    line(1, 610, [523, "321-508365"]),
    line(1, 471, [50, "04 Depósitos"], [327, "+"], [395, "12,485.00"]),
    line(1, 170, [43, "Detalle de la actividad de su FlexiCuenta"]),
    line(1, 107, [50, "Depósitos"]),
    line(1, 88, [50, "Hojas de Depósito"]),
    line(1, 71, [50, "Fecha"], [123, "Referencia"], [187, "Descripción"], [397, "Cantidad"]),
    line(1, 59, [50, "12-23"], [121, "245002412"], [187, "Depósito"], [396, "3,320.00"]),
    line(2, 469, [201, "01 Total de hojas de depósito"], [388, "$3,320.00"]),
    line(2, 457, [201, "01 Total de depósitos"], [388, "$3,320.00"]),
    line(2, 438, [50, "Retiros"]),
    line(2, 419, [50, "Cheques Pagados"]),
    line(
      2,
      387,
      [50, "00000000004"],
      [105, "12-06"],
      [141, "500099971"],
      [208, "85.00"],
      [248, "00000000008"],
      [303, "12-24"],
      [339, "501015440"],
      [402, "557.00"],
    ),
    line(2, 353, [201, "02 Cheques Pagados"], [392, "$642.00"]),
    line(2, 336, [50, "Otros Débitos"]),
    line(2, 311, [50, "12-02"], [187, "Compra"], [227, "12-01 Indeed 100509588"], [406, "43.81"]),
    line(2, 302, [187, "X8280"], [218, "800-4625842"]),
    line(2, 168, [602, "ADS0066S-1/1/25-705"]),
    line(2, 166, [50, "12-40"], [187, "Compra"], [406, "9.99"]),
    line(2, 150, [201, "03 Total de retiros"], [388, "$685.81"]),
    line(3, 393, [50, "Créditos y Débitos Misceláneos"]),
    line(3, 368, [50, "Efectividad"]),
    line(3, 359, [50, "12-18"], [187, "Credito"], [227, "12-17 X8280"], [354, "+"], [408, "27.17"]),
    line(3, 340, [50, "12-19"], [187, "Ajuste"], [408, "5.00"]),
    line(3, 319, [50, "Cargos por Servicios"]),
    line(3, 295, [50, "Mantenimiento FlexiCheques"], [412, "0.00"]),
    line(3, 278, [72, "Balance Promedio (Cheque y Ahorro) durante el Ciclo: $46,948.52"]),
    line(3, 167, [50, "Servicios Comerciales"], [408, "10.00"]),
    line(3, 100, [50, "Historial de Balance Diario"]),
    line(3, 90, [50, "12-27"], [140, "0.00"], [212, "0.00"]),
  ];
  const statement = parseBankStatement({ pages: 3, lines, textItems: 40 });

  it("signs rows by heading, reads + / - markers, and never guesses", () => {
    expect(statement.periodStart).toBe("2024-11-30");
    expect(statement.periodEnd).toBe("2024-12-31");
    expect(statement.accountNumber).toBe("321-508365");
    expect(statement.rows.map((row) => [row.date, row.amount, row.description])).toEqual([
      ["2024-12-23", "3320.00", "Depósito"],
      ["2024-12-06", "-85.00", "Cheque 4"],
      ["2024-12-24", "-557.00", "Cheque 8"],
      ["2024-12-02", "-43.81", "Compra 12-01 Indeed 100509588 X8280 800-4625842"],
      ["2024-12-18", "27.17", "Credito 12-17 X8280"],
    ]);
    expect(statement.skipped.map((skip) => skip.reason)).toEqual([
      "Date is outside the statement period",
      "Miscellaneous line without a + or - marker",
      "Service charge printed without a posting date",
    ]);
  });

  it("compares parsed rows with the printed section totals", () => {
    expect(statement.totalChecks).toEqual([
      {
        label: "Total de depósitos",
        printedCount: 1,
        printedAmount: "3320.00",
        parsedCount: 1,
        parsedAmount: "3320.00",
        matches: true,
      },
      {
        label: "Total de retiros",
        printedCount: 3,
        printedAmount: "685.81",
        parsedCount: 3,
        parsedAmount: "685.81",
        matches: true,
      },
    ]);
  });
});

function cell(
  row: number,
  col: number,
  kind: SheetCell["kind"],
  text: string,
  formula = false,
): SheetCell {
  return { row, col, kind, text, formula };
}

describe("statement sheets", () => {
  it("reads period headers, labeled lines, and flags an all-formula total column", () => {
    const sheet = parseStatementSheet(
      {
        name: "2023 IS (Apolinar)",
        cells: [
          cell(1, 1, "string", "Financial Row"),
          cell(1, 2, "number", "44957"),
          cell(1, 3, "number", "44985", true),
          cell(1, 4, "number", "45016", true),
          cell(2, 1, "string", "Sales"),
          cell(3, 1, "string", "4001 - Sales"),
          cell(3, 2, "number", "3293269.45"),
          cell(3, 3, "number", "8798.4699999999993"),
          cell(3, 4, "number", "3302067.9199999999", true),
          cell(4, 1, "string", "Total - Sales"),
          cell(4, 2, "number", "3293269.45", true),
          cell(4, 3, "string", "n/a"),
          cell(5, 2, "number", "1"),
        ],
      },
      "2023 Apolinar IS.xlsx",
    );
    if ("reason" in sheet) throw new Error(sheet.reason);
    expect(sheet.statementType).toBe("income_statement");
    expect(sheet.periods.map((period) => [period.label, period.derived])).toEqual([
      ["2023-01-31", false],
      ["2023-02-28", false],
      ["2023-03-31", true],
    ]);
    expect(
      sheet.lines.map((row) => [row.label, row.kind, row.values.map((value) => value.amount)]),
    ).toEqual([
      ["Sales", "heading", []],
      ["4001 - Sales", "line", ["3293269.45", "8798.47", "3302067.92"]],
      ["Total - Sales", "total", ["3293269.45"]],
    ]);
    expect(sheet.skippedCells).toBe(1);
    expect(sheet.skippedRows).toBe(1);
  });

  it("refuses a sheet it cannot classify", () => {
    const outcome = parseStatementSheet(
      {
        name: "Sheet1",
        cells: [
          cell(1, 2, "number", "44957"),
          cell(1, 3, "number", "44985"),
          cell(2, 1, "string", "Widgets"),
          cell(2, 2, "number", "5"),
        ],
      },
      "export.xlsx",
    );
    expect(outcome).toEqual({
      reason: "Could not tell whether this sheet is an income statement or a balance sheet",
    });
  });
});

function workbook(sheetName: string, rowsXml: string): string {
  const files = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(
      `<workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`),
  });
  return Buffer.from(files).toString("base64");
}

const BALANCE_SHEET = workbook(
  "BS",
  '<row r="1"><c r="B1"><v>45322</v></c><c r="C1"><v>45351</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>1000 · Cash</t></is></c><c r="B2"><v>100.5</v></c><c r="C2"><v>200.25</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Total Assets</t></is></c><c r="B3"><f>B2</f><v>100.5</v></c><c r="C3"><f>C2</f><v>200.25</v></c></row>',
);

async function provisioned() {
  const app = await testApp();
  await sessions(app).register("owner-1");
  const tenant = await call(app, "POST", "/v1/tenants", {
    actor: "platform-admin",
    body: { name: "Import Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
  });
  if (tenant.status !== 201) throw new Error(await tenant.text());
  const { tenantId } = (await tenant.json()) as { tenantId: string };
  return { app, tenantId };
}

describe("POST /v1/imports/file", () => {
  it("rejects an empty file", async () => {
    const { app, tenantId } = await provisioned();
    const response = await call(app, "POST", "/v1/imports/file", {
      actor: "owner-1",
      tenant: tenantId,
      body: {
        kind: "financial_statements",
        cadence: "monthly",
        fileName: "empty.pdf",
        contentBase64: "",
      },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "IMPORT_EMPTY_FILE",
    );
  });

  it("parses without storing when no company is selected", async () => {
    const app = await testApp();
    const response = await call(app, "POST", "/v1/imports/file", {
      actor: "owner-1",
      body: {
        kind: "financial_statements",
        cadence: "monthly",
        fileName: "Balance Sheet.xlsx",
        contentBase64: BALANCE_SHEET,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stored: boolean; importBatchId: string | null };
    expect(body.stored).toBe(false);
    expect(body.importBatchId).toBeNull();
  });

  it("stores a statement workbook once, keyed by the file hash, with cadence as metadata", async () => {
    const { app, tenantId } = await provisioned();
    const upload = () =>
      call(app, "POST", "/v1/imports/file", {
        actor: "owner-1",
        tenant: tenantId,
        body: {
          kind: "financial_statements",
          cadence: "monthly",
          fileName: "Balance Sheet.xlsx",
          contentBase64: BALANCE_SHEET,
        },
      });
    const first = await upload();
    if (first.status !== 201) throw new Error(await first.text());
    const stored = (await first.json()) as {
      stored: boolean;
      fileHash: string;
      cadence: string;
      statements: { sheets: { statementType: string; periodCount: number; valueCount: number }[] };
    };
    expect(stored.stored).toBe(true);
    expect(stored.fileHash).toBe(
      (await import("node:crypto"))
        .createHash("sha256")
        .update(Buffer.from(BALANCE_SHEET, "base64"))
        .digest("hex"),
    );
    expect(stored.cadence).toBe("monthly");
    expect(stored.statements.sheets).toEqual([
      expect.objectContaining({ statementType: "balance_sheet", periodCount: 2, valueCount: 4 }),
    ]);

    const replay = await upload();
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(true);
  });

  it("names a legacy .xls workbook instead of guessing", async () => {
    const { app, tenantId } = await provisioned();
    const xls = Buffer.from("d0cf11e0a1b11ae100000000", "hex").toString("base64");
    const response = await call(app, "POST", "/v1/imports/file", {
      actor: "owner-1",
      tenant: tenantId,
      body: {
        kind: "financial_statements",
        cadence: "yearly",
        fileName: "old.xls",
        contentBase64: xls,
      },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "IMPORT_FORMAT_UNSUPPORTED",
    );
  });

  it("stores a CSV income statement", async () => {
    const { app, tenantId } = await provisioned();
    const csv =
      "Line,Current Month This Year,Year to Date This Year\nSales,119668.99,2157467.10\nTotal Revenues,2157467.10,2157467.10\n";
    const response = await call(app, "POST", "/v1/imports/file", {
      actor: "owner-1",
      tenant: tenantId,
      body: {
        kind: "financial_statements",
        cadence: "yearly",
        fileName: "Income Statement.csv",
        contentBase64: Buffer.from(csv).toString("base64"),
      },
    });
    if (response.status !== 201) throw new Error(await response.text());
    const body = (await response.json()) as {
      cadence: string;
      statements: {
        sheets: { statementType: string; valuedLineCount: number; firstPeriod: string }[];
      };
    };
    expect(body.cadence).toBe("yearly");
    expect(body.statements.sheets[0]).toEqual(
      expect.objectContaining({
        statementType: "income_statement",
        valuedLineCount: 2,
        firstPeriod: "Current Month This Year",
      }),
    );
  });
});

describe("statement files from the demo layouts", () => {
  it("reads a QuickBooks PDF balance sheet", () => {
    const book = parseStatementPdf(
      {
        pages: 1,
        textItems: 8,
        lines: [
          line(1, 700, [260, "ENTREGAMEDS LLC"]),
          line(1, 680, [278, "Balance Sheet"]),
          line(1, 660, [268, "December 31, 2024"]),
          line(1, 640, [288, "ASSETS"]),
          line(1, 620, [20, "Cash on Hand"], [194, "$"], [470, "1.00"]),
          line(1, 600, [20, "Total Assets"], [288, "$"], [479, "625,347.79"]),
        ],
      },
      "balance.pdf",
    );
    const sheet = book.sheets[0];
    expect(sheet?.statementType).toBe("balance_sheet");
    expect(sheet?.periods.map((period) => period.label)).toEqual(["December 31, 2024"]);
    const cash = sheet?.lines.find((row) => row.label === "Cash on Hand");
    expect(cash?.values[0]?.amount).toBe("1.00");
    expect(sheet?.lines.find((row) => row.label === "Total Assets")?.values[0]?.amount).toBe(
      "625347.79",
    );
  });

  it("reads an audited balance sheet that prints whole dollars", () => {
    const book = parseStatementPdf(
      {
        pages: 1,
        textItems: 6,
        lines: [
          line(1, 700, [256, "BALANCE SHEET"]),
          line(1, 680, [264, "APRIL 30, 2024"]),
          line(1, 640, [90, "Cash and cash equivalents"], [453, "$"], [479, "733,447"]),
          line(1, 620, [108, "Total current assets"], [469, "1,526,602"]),
        ],
      },
      "audited.pdf",
    );
    expect(
      book.sheets[0]?.lines.find((row) => row.label === "Cash and cash equivalents")?.values[0]
        ?.amount,
    ).toBe("733447");
  });

  it("reads a CSV with the same columns as the monthly workbooks", () => {
    const book = parseStatementCsv(
      'Account,"December 31, 2024"\nCash,"1,024.46"\nTotal Assets,"2,000.00"\n',
      "Balance Sheet.csv",
    );
    expect(book.sheets[0]?.statementType).toBe("balance_sheet");
    expect(book.sheets[0]?.lines.find((row) => row.label === "Cash")?.values[0]?.amount).toBe(
      "1024.46",
    );
  });

  it("reads an income sheet whose period headers contain line breaks", () => {
    const cells: SheetCell[] = [
      { row: 1, col: 2, kind: "string", text: "Current Month\nThis Year", formula: false },
      { row: 1, col: 3, kind: "string", text: "Year to Date\nThis Year", formula: false },
      { row: 2, col: 1, kind: "string", text: "Sales", formula: false },
      { row: 2, col: 2, kind: "number", text: "10.5", formula: false },
      { row: 2, col: 3, kind: "number", text: "20.25", formula: false },
    ];
    const book = parseStatementWorkbook([{ name: "Income 2 yrs", cells }], "income.xlsx");
    expect(book.sheets[0]?.periods.map((period) => period.label)).toEqual([
      "Current Month This Year",
      "Year to Date This Year",
    ]);
    expect(book.sheets[0]?.lines[0]?.values.map((value) => value.amount)).toEqual([
      "10.5",
      "20.25",
    ]);
  });

  const demoZip = fileURLToPath(
    new URL(
      "../../../docs/demo_data/financial_statements/yearly_quaterly/Datasets for Testing.zip",
      import.meta.url,
    ),
  );

  it.skipIf(!existsSync(demoZip))(
    "reads the Entregameds PDF and the Omega workbook from the demo zip",
    async () => {
      const packed = unzipSync(readFileSync(demoZip), {
        filter: (file) =>
          file.name.endsWith("1 Entregameds Balance Sheet 2024.pdf") ||
          file.name.endsWith("Copy of I-S Y B-S OMEGA LLC 2025.xlsx"),
      });
      const pdfName = Object.keys(packed).find((name) => name.endsWith(".pdf"));
      const xlsxName = Object.keys(packed).find((name) => name.endsWith(".xlsx"));
      if (!pdfName || !xlsxName) throw new Error("demo zip is missing the expected files");
      const pdf = parseStatementPdf(
        await extractPdfText(packed[pdfName] ?? new Uint8Array()),
        pdfName,
      );
      const cash = pdf.sheets[0]?.lines.find((row) => row.label === "Cash on Hand");
      expect(cash?.values[0]?.amount).toBe("1.00");
      expect(
        pdf.sheets[0]?.lines.find((row) => row.label === "Total Assets")?.values[0]?.amount,
      ).toBe("625347.79");
      const workbook = parseStatementWorkbook(
        readWorkbook(packed[xlsxName] ?? new Uint8Array()),
        xlsxName,
      );
      expect(workbook.sheets.map((sheet) => sheet.statementType).sort()).toEqual([
        "balance_sheet",
        "income_statement",
      ]);
      expect(workbook.skippedSheets).toEqual([]);
    },
  );
});
