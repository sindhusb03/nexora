import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AnalyticalDecimal, mapLineLabel, mappingIsAutoAcceptable } from "@nexora/kernel";
import { describe, expect, it } from "vitest";

import { parseMoneyToken } from "../src/imports/decimal-text.js";
import {
  detectCurrency,
  detectScale,
  normalizePeriod,
  selectDocumentParser,
  type ParsedCell,
} from "../src/imports/document-parser.js";
import { decimalToMinor } from "../src/ingestion/service.js";
import { renderTextPdf, type PdfTextRow } from "../src/imports/text-pdf.js";
import { writeXlsx, type XlsxCell } from "../src/imports/xlsx-write.js";

/** Dev set. These expectations are hand-authored, not a blind held-out sample. */
const ACCURACY_THRESHOLD = 0.98;

interface HeldCell {
  readonly label: string;
  readonly amount: string;
  readonly statementType: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly scale: string;
  readonly currency: string | null;
  readonly accountCode: string | null;
  readonly autoAccept: boolean;
  readonly page?: number | null;
  readonly bbox?: boolean;
}

interface HeldDoc {
  readonly id: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly cells: readonly HeldCell[];
  readonly issues?: readonly string[];
}

const corpus = fileURLToPath(new URL("./fixtures/corpus/", import.meta.url));

describe("ingestion dev set", () => {
  it("keeps the synthetic corpus as source documents only", () => {
    const sources = readdirSync(corpus).filter(
      (name) => !name.endsWith(".expected.json") && name !== "index.json",
    );
    expect(sources.length).toBeGreaterThanOrEqual(20);
    expect(readdirSync(corpus).some((name) => name.endsWith(".expected.json"))).toBe(false);
  });

  it("parses ungrouped, Indian, bracket, and CR/DR amounts without truncation", () => {
    expect(parseMoneyToken("1223456.78")).toBe("1223456.78");
    expect(parseMoneyToken("150000.00")).toBe("150000.00");
    expect(parseMoneyToken("1,50,000.00")).toBe("150000.00");
    expect(parseMoneyToken("1,234,567.89")).toBe("1234567.89");
    expect(parseMoneyToken("(40.25)")).toBe("-40.25");
    expect(parseMoneyToken("25,000.00 CR")).toBe("25000.00");
    expect(parseMoneyToken("8000.00 DR")).toBe("-8000.00");
    expect(parseMoneyToken("-3100.00")).toBe("-3100.00");
  });

  it("detects fiscal years, millions, '000, and S$/A$", () => {
    expect(normalizePeriod("FY2024-25", false, false)).toBeNull();
    expect(normalizePeriod("FY2025-26", false, false)).toBeNull();
    expect(normalizePeriod("FY2024-25", false, false, { month: 3, day: 31 })).toMatchObject({
      periodStart: "2024-04-01",
      periodEnd: "2025-03-31",
      spanMonths: 12,
    });
    expect(normalizePeriod("FY2025-26", false, false, { month: 3, day: 31 })).toMatchObject({
      periodStart: "2025-04-01",
      periodEnd: "2026-03-31",
    });
    expect(normalizePeriod("31 March 2025", true, true)).toMatchObject({
      periodStart: "2024-04-01",
      periodEnd: "2025-03-31",
      spanMonths: 12,
    });
    expect(normalizePeriod("2025", false, true)).toBeNull();
    expect(normalizePeriod("2025", false, false, { month: 3, day: 31 })).toMatchObject({
      periodStart: "2024-04-01",
      periodEnd: "2025-03-31",
    });
    expect(normalizePeriod("December 31, 2024", true, false)).toMatchObject({
      periodStart: "2024-01-01",
      periodEnd: "2024-12-31",
      spanMonths: 12,
    });
    expect(detectScale("Amounts in lakhs")).toBe("lakhs");
    expect(detectScale("Amounts in millions")).toBe("millions");
    expect(detectScale("Figures in '000")).toBe("thousands");
    expect(detectCurrency("S$")).toBe("SGD");
    expect(detectCurrency("A$")).toBe("AUD");
    expect(decimalToMinor("120.50", "INR", "lakhs", false)).toBe("1205000000");
  });

  it("scores the hand-authored dev set at or above the threshold", async () => {
    const docs = heldOut();
    let expectedCells = 0;
    let matchedCells = 0;
    let expectedMaps = 0;
    let matchedMaps = 0;
    const mapMisses: string[] = [];

    for (const doc of docs) {
      const parsed = await selectDocumentParser(doc.fileName, doc.bytes).parse({
        fileName: doc.fileName,
        bytes: doc.bytes,
      });
      if (doc.issues) {
        expect(parsed.issues.map((issue) => issue.code).sort()).toEqual([...doc.issues].sort());
      }
      expectedCells += doc.cells.length;
      for (const expected of doc.cells) {
        const actual = parsed.cells.find(
          (cell) => cell.label === expected.label && sameAmount(cell.amount, expected.amount),
        );
        if (cellMatches(actual, expected)) matchedCells += 1;
        expectedMaps += 1;
        if (mapMatches(expected)) matchedMaps += 1;
        else {
          const hit = mapLineLabel(expected.label);
          mapMisses.push(
            `${doc.id}:${expected.label} expected ${expected.accountCode}/${expected.autoAccept} got ${hit?.accountCode ?? "null"}/${hit ? mappingIsAutoAcceptable(hit.confidence) : "null"}`,
          );
        }
      }
      const labels = parsed.cells
        .map((cell) => `${cell.label}|${canonicalAmount(cell.amount)}`)
        .sort();
      expect(labels).toEqual(
        doc.cells.map((cell) => `${cell.label}|${canonicalAmount(cell.amount)}`).sort(),
      );
    }

    expect(mapMisses).toEqual([]);
    const cellAccuracy = expectedCells === 0 ? 0 : matchedCells / expectedCells;
    const mappingAccuracy = expectedMaps === 0 ? 0 : matchedMaps / expectedMaps;
    expect(cellAccuracy).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);
    expect(mappingAccuracy).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);
    expect({
      documents: docs.length,
      cells: `${matchedCells}/${expectedCells}`,
      mappings: `${matchedMaps}/${expectedMaps}`,
      cellAccuracy,
      mappingAccuracy,
    }).toEqual({
      documents: docs.length,
      cells: `${expectedCells}/${expectedCells}`,
      mappings: `${expectedMaps}/${expectedMaps}`,
      cellAccuracy: 1,
      mappingAccuracy: 1,
    });
  });
});

function sameAmount(left: string, right: string): boolean {
  return new AnalyticalDecimal(left).eq(right);
}

function canonicalAmount(value: string): string {
  return new AnalyticalDecimal(value).toFixed();
}

function cellMatches(actual: ParsedCell | undefined, expected: HeldCell): boolean {
  if (!actual) return false;
  if (actual.statementType !== expected.statementType) return false;
  if (actual.periodStart !== expected.periodStart || actual.periodEnd !== expected.periodEnd) {
    return false;
  }
  if (actual.scale !== expected.scale || actual.currency !== expected.currency) return false;
  if (expected.page !== undefined && actual.page !== expected.page) return false;
  if (expected.bbox && actual.bbox === null) return false;
  return true;
}

function mapMatches(expected: HeldCell): boolean {
  const hit = mapLineLabel(expected.label);
  if (expected.accountCode === null) return hit === null;
  return (
    hit?.accountCode === expected.accountCode &&
    mappingIsAutoAcceptable(hit.confidence) === expected.autoAccept
  );
}

function heldOut(): HeldDoc[] {
  return [
    {
      id: "lakhs-csv",
      fileName: "in-lakhs-profit-and-loss.csv",
      bytes: text(
        [
          "Year ended 31 March 2025",
          "Profit and Loss,FY2024-25",
          "Amounts in lakhs,INR",
          "Revenue from operations,120.50",
          "Cost of Sales,(40.25)",
          "Operating Expenses,10",
          "Net Income,70.25",
        ].join("\n"),
      ),
      cells: [
        cell(
          "Revenue from operations",
          "120.50",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "lakhs",
          "INR",
          "revenue",
          true,
        ),
        cell(
          "Cost of Sales",
          "-40.25",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "lakhs",
          "INR",
          "cogs",
          true,
        ),
        cell(
          "Operating Expenses",
          "10",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "lakhs",
          "INR",
          "operating_expenses",
          true,
        ),
        cell(
          "Net Income",
          "70.25",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "lakhs",
          "INR",
          "net_income",
          true,
        ),
      ],
    },
    {
      id: "fy-march",
      fileName: "in-march-profit-and-loss.csv",
      bytes: text(
        ["Profit and Loss,31 March 2025", "Year ended 31 March 2025", "Revenue,10.00"].join("\n"),
      ),
      cells: [
        cell(
          "Revenue",
          "10.00",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "units",
          null,
          "revenue",
          true,
        ),
      ],
    },
    {
      id: "millions",
      fileName: "us-millions-profit-and-loss.csv",
      bytes: text(
        [
          "Profit and Loss,Year ended 31 December 2024",
          "Amounts in millions,USD",
          "Revenue,1.25",
        ].join("\n"),
      ),
      cells: [
        cell(
          "Revenue",
          "1.25",
          "income_statement",
          "2024-01-01",
          "2024-12-31",
          "millions",
          "USD",
          "revenue",
          true,
        ),
      ],
    },
    {
      id: "thousands",
      fileName: "us-thousands-profit-and-loss.csv",
      bytes: text(
        ["Profit and Loss,Year ended 31 December 2024", "Figures in '000,USD", "Revenue,10"].join(
          "\n",
        ),
      ),
      cells: [
        cell(
          "Revenue",
          "10",
          "income_statement",
          "2024-01-01",
          "2024-12-31",
          "thousands",
          "USD",
          "revenue",
          true,
        ),
      ],
    },
    {
      id: "sgd",
      fileName: "sg-profit-and-loss.csv",
      bytes: text(
        ["Profit and Loss,Year ended 31 December 2024", "Currency,S$", "Revenue,10"].join("\n"),
      ),
      cells: [
        cell(
          "Revenue",
          "10",
          "income_statement",
          "2024-01-01",
          "2024-12-31",
          "units",
          "SGD",
          "revenue",
          true,
        ),
      ],
    },
    {
      id: "aud",
      fileName: "au-profit-and-loss.csv",
      bytes: text(
        ["Profit and Loss,Year ended 31 December 2024", "Currency,A$", "Revenue,10"].join("\n"),
      ),
      cells: [
        cell(
          "Revenue",
          "10",
          "income_statement",
          "2024-01-01",
          "2024-12-31",
          "units",
          "AUD",
          "revenue",
          true,
        ),
      ],
    },
    {
      id: "xlsx-text",
      fileName: "in-text-balance-sheet.xlsx",
      bytes: writeXlsx([
        {
          name: "Balance Sheet",
          cells: [
            x(1, 1, "Balance Sheet"),
            x(1, 2, "Year ended 31 December 2024"),
            x(2, 1, "Cash"),
            x(2, 2, "1,50,000.00"),
            x(3, 1, "Trade Payables"),
            x(3, 2, "40,000.00"),
            x(4, 1, "Reserves and Surplus"),
            x(4, 2, "1,10,000.00"),
          ],
        },
      ]),
      cells: [
        cell(
          "Cash",
          "150000.00",
          "balance_sheet",
          "2024-01-01",
          "2024-12-31",
          "units",
          null,
          "cash",
          true,
        ),
        cell(
          "Trade Payables",
          "40000.00",
          "balance_sheet",
          "2024-01-01",
          "2024-12-31",
          "units",
          null,
          "accounts_payable",
          true,
        ),
        cell(
          "Reserves and Surplus",
          "110000.00",
          "balance_sheet",
          "2024-01-01",
          "2024-12-31",
          "units",
          null,
          "retained_earnings",
          true,
        ),
      ],
    },
    {
      id: "tally",
      fileName: "in-tally-profit-and-loss.csv",
      bytes: text(
        [
          "Year ended 31 March 2025",
          "Profit and Loss,FY2024-25",
          "Sales Accounts,1000.00",
          "Purchases,400.00",
        ].join("\n"),
      ),
      cells: [
        cell(
          "Sales Accounts",
          "1000.00",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "units",
          null,
          "revenue",
          true,
        ),
        cell(
          "Purchases",
          "400.00",
          "income_statement",
          "2024-04-01",
          "2025-03-31",
          "units",
          null,
          "cogs",
          true,
        ),
      ],
    },
    {
      id: "hdfc",
      fileName: "hdfc-statement.csv",
      bytes: text(
        [
          "HDFC Bank,INR",
          "Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance",
          "01/04/2024,Opening Balance,,,150000.00",
          "05/04/2024,NEFT inward,,25000.00,175000.00",
          "18/04/2024,Vendor payment,8000.00,,167000.00",
        ].join("\n"),
      ),
      cells: [
        cell(
          "Opening balance",
          "150000.00",
          "bank",
          "2024-04-01",
          "2024-04-18",
          "units",
          "INR",
          null,
          false,
        ),
        cell(
          "NEFT inward",
          "25000.00",
          "bank",
          "2024-04-01",
          "2024-04-18",
          "units",
          "INR",
          null,
          false,
        ),
        cell(
          "Vendor payment",
          "-8000.00",
          "bank",
          "2024-04-01",
          "2024-04-18",
          "units",
          "INR",
          null,
          false,
        ),
        cell(
          "Closing balance",
          "167000.00",
          "bank",
          "2024-04-01",
          "2024-04-18",
          "units",
          "INR",
          null,
          false,
        ),
      ],
    },
    {
      id: "chase",
      fileName: "chase-statement.csv",
      bytes: text(
        [
          "Chase,USD",
          "Date,Description,Amount,Balance",
          "03/05/2024,Beginning Balance,,22000.00",
          "03/06/2024,ACH credit,5400.00,27400.00",
          "03/22/2024,Wire out rent,-3100.00,24300.00",
        ].join("\n"),
      ),
      cells: [
        cell(
          "Opening balance",
          "22000.00",
          "bank",
          "2024-03-05",
          "2024-03-22",
          "units",
          "USD",
          null,
          false,
        ),
        cell(
          "ACH credit",
          "5400.00",
          "bank",
          "2024-03-05",
          "2024-03-22",
          "units",
          "USD",
          null,
          false,
        ),
        cell(
          "Wire out rent",
          "-3100.00",
          "bank",
          "2024-03-05",
          "2024-03-22",
          "units",
          "USD",
          null,
          false,
        ),
        cell(
          "Closing balance",
          "24300.00",
          "bank",
          "2024-03-05",
          "2024-03-22",
          "units",
          "USD",
          null,
          false,
        ),
      ],
    },
    {
      id: "ambiguous-date",
      fileName: "ambiguous-bank.csv",
      bytes: text(
        ["Date,Description,Amount,Balance", "01/02/2024,Payment,10.00,100.00"].join("\n"),
      ),
      cells: [],
      issues: ["ambiguous_date", "balance_mismatch"],
    },
    {
      id: "zero",
      fileName: "empty-profit-and-loss.csv",
      bytes: text(["Profit and Loss,Notes", "Hello,world"].join("\n")),
      cells: [],
      issues: ["zero_extraction"],
    },
    {
      id: "hdfc-pdf",
      fileName: "hdfc-statement.pdf",
      bytes: renderTextPdf([
        [
          row([
            ["40", "HDFC Bank"],
            ["200", "INR"],
          ]),
          row([
            ["40", "Date"],
            ["140", "Narration"],
            ["280", "Withdrawal Amt."],
            ["400", "Deposit Amt."],
            ["500", "Closing Balance"],
          ]),
          row([
            ["40", "01/04/2024"],
            ["140", "Opening Balance"],
            ["280", "-"],
            ["400", "-"],
            ["500", "150000.00"],
          ]),
          row([
            ["40", "18/04/2024"],
            ["140", "NEFT inward"],
            ["280", "-"],
            ["400", "25000.00"],
            ["500", "175000.00"],
          ]),
        ],
      ]),
      cells: [
        {
          ...cell(
            "Opening balance",
            "150000.00",
            "bank",
            "2024-04-01",
            "2024-04-18",
            "units",
            "INR",
            null,
            false,
          ),
          page: 1,
          bbox: true,
        },
        {
          ...cell(
            "NEFT inward",
            "25000.00",
            "bank",
            "2024-04-01",
            "2024-04-18",
            "units",
            "INR",
            null,
            false,
          ),
          page: 1,
          bbox: true,
        },
        {
          ...cell(
            "Closing balance",
            "175000.00",
            "bank",
            "2024-04-01",
            "2024-04-18",
            "units",
            "INR",
            null,
            false,
          ),
          page: 1,
          bbox: true,
        },
      ],
    },
    {
      id: "chase-pdf",
      fileName: "chase-statement.pdf",
      bytes: renderTextPdf([
        [
          row([
            ["40", "Chase"],
            ["160", "USD"],
          ]),
          row([
            ["40", "Date"],
            ["140", "Description"],
            ["300", "Amount"],
            ["420", "Balance"],
          ]),
          row([
            ["40", "03/05/2024"],
            ["140", "Beginning Balance"],
            ["300", "-"],
            ["420", "22000.00"],
          ]),
          row([
            ["40", "03/22/2024"],
            ["140", "ACH credit"],
            ["300", "5400.00"],
            ["420", "27400.00"],
          ]),
        ],
      ]),
      cells: [
        {
          ...cell(
            "Opening balance",
            "22000.00",
            "bank",
            "2024-03-05",
            "2024-03-22",
            "units",
            "USD",
            null,
            false,
          ),
          page: 1,
          bbox: true,
        },
        {
          ...cell(
            "ACH credit",
            "5400.00",
            "bank",
            "2024-03-05",
            "2024-03-22",
            "units",
            "USD",
            null,
            false,
          ),
          page: 1,
          bbox: true,
        },
        {
          ...cell(
            "Closing balance",
            "27400.00",
            "bank",
            "2024-03-05",
            "2024-03-22",
            "units",
            "USD",
            null,
            false,
          ),
          page: 1,
          bbox: true,
        },
      ],
    },
    {
      id: "two-page-pdf",
      fileName: "income-statement.pdf",
      bytes: renderTextPdf([
        [
          row([["72", "Income Statement"]]),
          row([["72", "December 31, 2024"]]),
          row([
            ["72", "Revenue"],
            ["400", "100.00"],
          ]),
        ],
        [
          row([
            ["72", "Operating Expenses"],
            ["400", "(40.25)"],
          ]),
        ],
      ]),
      cells: [
        {
          ...cell(
            "Revenue",
            "100.00",
            "income_statement",
            "2024-12-01",
            "2024-12-31",
            "units",
            null,
            "revenue",
            true,
          ),
          page: 1,
          bbox: true,
        },
        {
          ...cell(
            "Operating Expenses",
            "-40.25",
            "income_statement",
            "2024-12-01",
            "2024-12-31",
            "units",
            null,
            "operating_expenses",
            true,
          ),
          page: 2,
          bbox: true,
        },
      ],
    },
  ];
}

function cell(
  label: string,
  amount: string,
  statementType: string,
  periodStart: string,
  periodEnd: string,
  scale: string,
  currency: string | null,
  accountCode: string | null,
  autoAccept: boolean,
): HeldCell {
  return {
    label,
    amount,
    statementType,
    periodStart,
    periodEnd,
    scale,
    currency,
    accountCode,
    autoAccept,
  };
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function x(row: number, col: number, value: string): XlsxCell {
  return { row, col, value, kind: "string" };
}

function row(items: readonly (readonly [string, string])[]): PdfTextRow {
  return { items: items.map(([xPosition, value]) => ({ x: Number(xPosition), text: value })) };
}
