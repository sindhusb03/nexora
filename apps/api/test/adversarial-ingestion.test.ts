import { describe, expect, it } from "vitest";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { parseBankText } from "../src/imports/bank-tabular.js";
import { parseMoneyToken } from "../src/imports/decimal-text.js";
import { writeXlsx } from "../src/imports/xlsx-write.js";
import { strToU8, zipSync } from "fflate";
import { decimalToMinor } from "../src/ingestion/service.js";
import { renderTextPdf } from "../src/imports/text-pdf.js";

async function csv(text: string) {
  const bytes = new TextEncoder().encode(text);
  return selectDocumentParser("income.csv", bytes).parse({ fileName: "income.csv", bytes });
}

describe("independent adversarial ingestion", () => {
  it.each(["Printed on:", "Report generated:", "Run at:", "Report date:"])(
    "ignores metadata %s even when it says as of",
    async (prefix) => {
      const parsed = await csv(
        `${prefix} as of 17 September 2026\nIncome statement USD\nYear ended 30 June 2025\nAccount,2025,2024\nRevenue,4200,3100`,
      );
      expect(parsed.cells.map((c) => c.periodEnd)).toEqual(["2025-06-30", "2024-06-30"]);
    },
  );
  it.each([
    "YTD",
    "Quarter Q2",
    "Half-year",
    "Nine-months ended",
    "Three months ended",
    "Six months ended",
    "For the month ended",
    "One month ended",
    "5 months ended",
    "Monthly report",
  ])("requires confirmation for %s, even with a full date column", async (span) => {
    const parsed = await csv(`Income statement USD\n${span}\nAccount,30 June 2025\nRevenue,4200`);
    expect(parsed.issues.some((i) => i.code === "confirm_period_end")).toBe(true);
    expect(parsed.cells).toEqual([]);
  });
  it.each(["FY27", "2026-27", "FY 2027"])("does not guess fiscal year %s", async (label) => {
    const parsed = await csv(`Income statement AUD\nAccount,${label}\nRevenue,4200`);
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.some((i) => i.code === "confirm_period_end")).toBe(true);
  });
  it("rejects a title and column date conflict", async () => {
    const parsed = await csv(
      "Income statement GBP\nYear ended 30 June 2025\nAccount,31 December 2025\nRevenue,4200",
    );
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.some((i) => i.code === "confirm_period_end")).toBe(true);
  });
  it("keeps text integers including year-shaped amounts under established columns", async () => {
    const rows = [
      ["Income statement USD"],
      ["Year ended 31 December 2025"],
      ["Account", "2025"],
      ["Revenue", "2024"],
      ["Operating expenses", "83"],
    ];
    const bytes = writeXlsx([
      {
        name: "Income",
        cells: rows.flatMap((row, r) =>
          row.map((value, c) => ({ row: r + 1, col: c + 1, value, kind: "string" as const })),
        ),
      },
    ]);
    const result = await selectDocumentParser("statement.xlsx", bytes).parse({
      fileName: "statement.xlsx",
      bytes,
    });
    expect(result.cells.map((c) => c.amount)).toEqual(["2024", "83"]);
  });
  it.each([
    ["1.234,56", "1234.56"],
    ["1 234,56", "1234.56"],
    ["1'234.56", "1234.56"],
    ["−42.50", "-42.50"],
    ["123,45", "123.45"],
  ])("reads local amount %s", (raw, amount) => {
    expect(parseMoneyToken(raw!)).toBe(amount);
  });
  it("never fabricates an opening balance", () => {
    const parsed = parseBankText(
      "USD\nDate,Description,Amount,Balance\n2025-08-12,Receipt,10.00,910.00\n2025-08-13,Fee,-5.00,905.00",
    );
    expect(parsed.bank?.opening).toBeNull();
    expect(parsed.issues.some((i) => i.code === "balance_mismatch")).toBe(true);
  });
  it("keeps undated opening and closing rows and ignores dated totals", () => {
    const parsed = parseBankText(
      "USD\nDate,Description,Debit,Credit,Balance\n,Opening balance,,,700.00\n2025-08-12,Receipt,,50.00,750.00\n2025-08-13,Fee,5.00,,745.00\n2025-08-13,Total,5.00,50.00,\n,Closing balance,,,745.00",
    );
    expect(parsed.bank?.opening).toBe("700.00");
    expect(parsed.bank?.closing).toBe("745.00");
    expect(parsed.bank?.transactions.map((t) => t.amount)).toEqual(["50.00", "-5.00"]);
    expect(parsed.issues).toEqual([]);
  });
  it("blocks a mismatched closing balance", () => {
    const parsed = parseBankText(
      "USD\nDate,Description,Amount,Balance\n2025-08-01,Opening balance,,700.00\n2025-08-12,Receipt,50.00,750.00\n2025-08-31,Closing balance,,799.00",
    );
    expect(parsed.issues.some((i) => i.code === "balance_mismatch")).toBe(true);
  });
  it("does not erase signs, duplicate amount columns, or unknown direction markers", () => {
    for (const header of ["Date,Description,Amount,Amount", "Date,Description,Amount,Direction"]) {
      const parsed = parseBankText(`${header}\n2025-08-14,Card,100.00,UNKNOWN`);
      expect(parsed.bank?.transactions ?? []).toEqual([]);
      expect(parsed.issues.length).toBeGreaterThan(0);
    }
  });
  it("rejects invalid calendar dates", async () => {
    const parsed = await csv("Year ended 31 February 2025\nAccount,31 February 2025\nRevenue,4200");
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it("requires scale confirmation when statements mix units", async () => {
    const parsed = await csv(
      "Income statement USD\nAmounts in thousands\nAmounts in millions\nYear ended 31 December 2025\nAccount,2025\nRevenue,42.50",
    );
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it("keeps each sheet's scale", async () => {
    const bytes = writeXlsx(
      ["units", "thousands"].map((scale) => ({
        name: `Income ${scale}`,
        cells: [
          ["Income USD"],
          [`Amounts in ${scale}`],
          ["Year ended 31 December 2025"],
          ["Account", "2025"],
          ["Revenue", "123.45"],
        ].flatMap((r, i) =>
          r.map((value, j) => ({ row: i + 1, col: j + 1, value, kind: "string" as const })),
        ),
      })),
    );
    const parsed = await selectDocumentParser("income.xlsx", bytes).parse({
      fileName: "income.xlsx",
      bytes,
    });
    expect(parsed.cells.map((c) => c.scale)).toEqual(["units", "thousands"]);
  });
  it("does not round source sub-minor values into a different amount", () => {
    expect(() => decimalToMinor("12.345", "USD", "units", false)).toThrow();
    expect(decimalToMinor("12.345", "USD", "thousands", false)).toBe("1234500");
  });
  it.each([false, true])("honors styled Excel dates with date1904=%s", async (date1904) => {
    const serial = Math.round(
      (Date.UTC(2025, 5, 30) -
        Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) /
        86400000,
    );
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="Income" r:id="r1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/styles.xml": strToU8(
        '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Year ended 30 June 2025</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Account</t></is></c><c r="B2" s="1"><v>${serial}</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Revenue</t></is></c><c r="B3"><v>43210</v></c></row></sheetData></worksheet>`,
      ),
    });
    const parsed = await selectDocumentParser("income.xlsx", bytes).parse({
      fileName: "income.xlsx",
      bytes,
    });
    expect(parsed.cells.map((c) => [c.amount, c.periodEnd])).toEqual([["43210", "2025-06-30"]]);
  });
  it("does not treat unformatted numeric money as an Excel date", async () => {
    const bytes = writeXlsx([
      {
        name: "Income",
        cells: [
          ["Revenue", "45000"],
          ["Operating expenses", "32000"],
        ].flatMap((r, i) =>
          r.map((value, j) => ({
            row: i + 1,
            col: j + 1,
            value,
            kind: j ? ("number" as const) : ("string" as const),
          })),
        ),
      },
    ]);
    const parsed = await selectDocumentParser("income.xlsx", bytes).parse({
      fileName: "income.xlsx",
      bytes,
    });
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it("interprets accounting Dr/Cr relative to the account, not bank direction", async () => {
    const parsed = await csv(
      "Year ended 31 December 2025\nAccount,2025\nCash,1400 Dr\nAccounts payable,300 Cr\nRevenue,2100 Cr\nOperating expenses,100 Dr",
    );
    expect(parsed.cells.map((c) => c.amount)).toEqual(["1400", "300", "2100", "100"]);
  });
  it("nets accounting debit and credit columns instead of taking the first", async () => {
    const parsed = await csv(
      "Year ended 31 December 2025\nParticulars,Debit,Credit\nCash,1400,100\nAccounts payable,25,300\nRevenue,0,2100\nOperating expenses,100,15",
    );
    expect(parsed.cells.map((c) => c.amount)).toEqual(["1300", "275", "2100", "85"]);
  });
  it("does not give duplicate period columns the same amounts", async () => {
    const parsed = await csv("Year ended 31 December 2025\nAccount,2025,2025\nRevenue,1400,2000");
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it("never mistakes narrative reference numbers for transaction amounts", () => {
    const parsed = parseBankText(
      "Period 2025-01-01 to 2025-01-31\nOpening balance 1000.00\n2025-01-15 Invoice 12345 deposit 200.00\nClosing balance 1200.00",
    );
    expect(parsed.bank?.transactions ?? []).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it("preserves significant decimal digits before applying a scale", async () => {
    const parsed = await csv(
      "Income statement USD\nYear ended 31 December 2025\nAmounts in millions\nAccount;2025\nRevenue;1.2300001",
    );
    expect(parsed.cells[0]?.amount).toBe("1.2300001");
  });
  it.each(["Income statement (USD 000)", "Income statement USD (000)", "USD in thousand"])(
    "reads scale cue %s",
    async (title) => {
      const parsed = await csv(`${title}\nYear ended 31 December 2025\nAccount;2025\nRevenue;7500`);
      expect(parsed.cells[0]?.scale).toBe("thousands");
    },
  );
  it("does not use a PDF print date as a single-column period", async () => {
    const bytes = renderTextPdf([
      [
        { items: [{ x: 30, text: "Printed 17 August 2025" }] },
        { items: [{ x: 30, text: "Income statement USD" }] },
        {
          items: [
            { x: 30, text: "Revenue" },
            { x: 350, text: "350.00" },
          ],
        },
      ],
    ]);
    const parsed = await selectDocumentParser("income.pdf", bytes).parse({
      fileName: "income.pdf",
      bytes,
    });
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it.each(["31 décembre 2025", "31. Dezember 2025", "2025年12月31日"])(
    "reads an explicit local date %s",
    async (date) => {
      const parsed = await csv(
        `Income statement EUR\nYear ended ${date}\nAccount;${date}\nRevenue;1234,50`,
      );
      expect(parsed.cells.map((c) => [c.amount, c.periodStart, c.periodEnd])).toEqual([
        ["1234.50", "2025-01-01", "2025-12-31"],
      ]);
    },
  );
  it("combines a yearless annual date title with comparative year columns", async () => {
    const parsed = await csv(
      "Income statement USD\nYear ended September 30\nAccount;2025;2024\nRevenue;2100;1900",
    );
    expect(parsed.cells.map((c) => c.periodEnd)).toEqual(["2025-09-30", "2024-09-30"]);
  });
  it("requires confirmation for differing dates on adjacent period columns", async () => {
    const parsed = await csv(
      "Income statement USD\nAccount;Year ended 30 June 2025;Year ended 31 December 2024\nRevenue;2100;1900",
    );
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.some((i) => i.code === "confirm_period_end")).toBe(true);
  });
  it("does not turn a short date range into a whole year", async () => {
    const parsed = await csv(
      "Income statement USD\n1-Jan-2025 to 15-Dec-2025\nAccount;Amount\nRevenue;2100",
    );
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
  it("does not silently treat unsupported scales as units", async () => {
    const parsed = await csv(
      "Income statement USD in billions\nYear ended 31 December 2025\nAccount;2025\nRevenue;2.10",
    );
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
});
