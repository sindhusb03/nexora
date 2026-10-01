import { describe, expect, it } from "vitest";

import {
  detectScale,
  normalizePeriod,
  selectDocumentParser,
} from "../src/imports/document-parser.js";
import { explicitYearEnd, periodDatesConflict, statementSpan } from "../src/imports/period.js";
import { parseMoneyToken } from "../src/imports/decimal-text.js";
import { renderTextPdf, type PdfTextRow } from "../src/imports/text-pdf.js";

function csv(
  name: string,
  text: string,
  yearEnd?: { readonly month: number; readonly day: number },
) {
  const bytes = new TextEncoder().encode(text);
  const parser = selectDocumentParser(name, bytes);
  return parser.parse(yearEnd ? { fileName: name, bytes, yearEnd } : { fileName: name, bytes });
}

function pdfRow(items: readonly (readonly [string, string])[]): PdfTextRow {
  return { items: items.map(([x, text]) => ({ x: Number(x), text })) };
}

describe("layout-agnostic extraction", () => {
  it("reads fiscal spans, note columns, scale words, and currency prefixes", async () => {
    expect(normalizePeriod("2025-26", false, false)).toBeNull();
    expect(normalizePeriod("FY 2025-26", false, false)).toBeNull();
    expect(normalizePeriod("FY26", false, false)).toBeNull();
    expect(normalizePeriod("2025-26", false, false, { month: 3, day: 31 })).toMatchObject({
      periodStart: "2025-04-01",
      periodEnd: "2026-03-31",
      spanMonths: 12,
    });
    expect(normalizePeriod("Mar-26", false, false)?.spanMonths).toBe(1);
    expect(normalizePeriod("Mar-26", true, true)?.periodEnd).toBe("2026-03-31");
    expect(normalizePeriod("31.03.2026", false, false)?.periodEnd).toBe("2026-03-31");
    expect(normalizePeriod("31-Mar-2026", false, false)?.periodStart).toBe("2025-04-01");
    expect(normalizePeriod("Year ended 31 March 2026", false, false)?.spanMonths).toBe(12);
    expect(parseMoneyToken("S$1,234.50")).toBe("1234.50");
    expect(parseMoneyToken("Rs. 1,50,000.00")).toBe("150000.00");
    expect(parseMoneyToken("US$10.00")).toBe("10.00");
    expect(detectScale("Rs in 000s")).toBe("thousands");
    expect(detectScale("(in millions)")).toBe("millions");
    expect(detectScale("₹ in lakhs")).toBe("lakhs");
    expect(detectScale("£m")).toBe("millions");
    expect(detectScale("$m")).toBe("millions");

    const fiscal = await csv("balance-sheet.csv", 'Account,2025-26\nCash,"100.00"\n');
    expect(fiscal.cells).toEqual([]);
    expect(fiscal.issues.some((issue) => issue.code === "confirm_period_end")).toBe(true);

    const noted = await csv(
      "balance-sheet.csv",
      'Year ended 31 March 2026\nParticulars,Note,FY26\nCash,,"10.00"\n',
    );
    expect(noted.issues.some((issue) => issue.code === "layout_unresolved")).toBe(false);
    expect(
      noted.cells.some((cell) => cell.label === "Cash" && cell.periodEnd === "2026-03-31"),
    ).toBe(true);

    const scaled = await csv(
      "profit-and-loss.csv",
      'Profit and loss\nRs in 000s\nYear ended 31 December 2024\nAccount,2024\nRevenue,"1,234.50"\n',
    );
    expect(scaled.scale).toBe("thousands");
    expect(
      scaled.cells.some((cell) => cell.label === "Revenue" && cell.scale === "thousands"),
    ).toBe(true);

    const prefixed = await csv(
      "balance-sheet.csv",
      'Year ended 31 December 2024\nAccount,2024\nCash,"S$1,234.50"\n',
    );
    expect(prefixed.currency).toBe("SGD");
    expect(prefixed.cells.some((cell) => cell.amount === "1234.50")).toBe(true);
  });

  it("reads a bank from column roles and currency, without a bank name", async () => {
    const parsed = await csv(
      "statement.csv",
      [
        "INR",
        "Tran Date,Details,Withdrawal,Deposit,Balance",
        "01/04/2024,Opening balance,,,150000.00",
        "02/04/2024,Receipt,,25000.00,175000.00",
        "18/04/2024,Vendor,100.00,,174900.00",
      ].join("\n"),
    );
    expect(parsed.issues.some((issue) => issue.code === "ambiguous_date")).toBe(false);
    const opening = parsed.cells.find((cell) => cell.balanceKind === "opening");
    const movement = parsed.cells.find((cell) => cell.balanceKind === "movement");
    expect(opening?.amount).toBe("150000.00");
    expect(movement?.amount).toBe("25000.00");
    expect(movement?.txnDate).toBe("2024-04-02");
  });

  it("resolves explicit year ends and refuses a bare year", async () => {
    expect(explicitYearEnd("Fiscal year 2025")).toBeNull();
    expect(explicitYearEnd("Fiscal year ended 30 June 2025")).toMatchObject({
      year: 2025,
      month: 6,
      day: 30,
    });
    expect(normalizePeriod("year ended 30 June 2025", false, false)).toMatchObject({
      periodStart: "2024-07-01",
      periodEnd: "2025-06-30",
      spanMonths: 12,
    });
    expect(normalizePeriod("12 months ended 30 Sep 2024", false, false)).toMatchObject({
      periodStart: "2023-10-01",
      periodEnd: "2024-09-30",
    });
    expect(normalizePeriod("as at 31 March 2025", false, false)?.periodEnd).toBe("2025-03-31");
    expect(normalizePeriod("year ended 31 December 2025", false, false)?.periodEnd).toBe(
      "2025-12-31",
    );
    expect(normalizePeriod("year ended 5 April 2025", false, false)).toMatchObject({
      periodStart: "2024-04-06",
      periodEnd: "2025-04-05",
    });
    expect(normalizePeriod("2025-06-30", true, false)?.periodEnd).toBe("2025-06-30");
    expect(normalizePeriod("2025-06-30", true, false)?.periodStart).toBe("2024-07-01");
    expect(normalizePeriod("Jun-25", true, false)?.periodEnd).toBe("2025-06-30");
    expect(normalizePeriod("2025", false, false)).toBeNull();

    const june = await csv(
      "balance-sheet.csv",
      "Fiscal year ended 30 June 2025\nAccount,2025\nCash,10.00\n",
    );
    expect(june.cells.some((cell) => cell.periodEnd === "2025-12-31")).toBe(false);
    expect(
      june.cells.some((cell) => cell.periodEnd === "2025-06-30" && cell.label === "Cash"),
    ).toBe(true);
    const bare = await csv("balance-sheet.csv", "Account,2025\nCash,10.00\n");
    expect(bare.cells).toEqual([]);
    expect(bare.issues.some((issue) => issue.code === "confirm_period_end")).toBe(true);
  });

  it("refuses an unknown grid instead of extracting part of it", async () => {
    const parsed = await csv("mystery.csv", "Foo,Bar\n1,2\n");
    expect(parsed.cells).toEqual([]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["layout_unresolved"]);
  });

  it("ignores a print date and refuses disagreeing statement dates", async () => {
    const printed =
      "Printed as of 14 August 2025\nYear ended 30 June 2025\nYear ended 30 June 2024\n";
    expect(explicitYearEnd(printed)).toMatchObject({ year: 2025, month: 6, day: 30 });
    expect(periodDatesConflict(printed)).toBe(false);
    const june = await csv("balance-sheet.csv", `${printed}Account,2025,2024\nCash,10.00,8.00\n`);
    expect(june.cells.map((cell) => cell.periodEnd).sort()).toEqual(["2024-06-30", "2025-06-30"]);
    expect(june.cells.some((cell) => cell.periodEnd === "2025-08-14")).toBe(false);

    const conflict = "Year ended 30 June 2025\nAs at 31 March 2025\nAccount,2025\nCash,10.00\n";
    expect(periodDatesConflict(conflict)).toBe(true);
    const mixed = await csv("balance-sheet.csv", conflict);
    expect(mixed.cells).toEqual([]);
    expect(mixed.issues.some((issue) => issue.code === "confirm_period_end")).toBe(true);
  });

  it("sends interim periods and bare FY labels to review", async () => {
    expect(statementSpan("Three Months Ended March 31,\n")).toBe(3);
    expect(statementSpan("Year to date\n")).toBe(-1);
    expect(
      statementSpan("Three months ended 31 March 2025\nSix months ended 30 September 2025\n"),
    ).toBe(-1);
    const quarter = await csv(
      "profit-and-loss.csv",
      "Three Months Ended March 31,\nAccount,2026,2025\nRevenue,10.00,8.00\n",
      { month: 12, day: 31 },
    );
    expect(quarter.cells).toEqual([]);
    expect(quarter.issues.some((issue) => issue.code === "confirm_period_end")).toBe(true);

    const fy = await csv("balance-sheet.csv", "Account,FY25\nCash,10.00\n");
    expect(fy.cells).toEqual([]);
    expect(fy.issues.some((issue) => issue.code === "confirm_period_end")).toBe(true);
  });

  it("reads dated bank rows without a running balance, and HTML, Tally, and PDF titles", async () => {
    const dated = await csv(
      "statement.csv",
      [
        "Date,Payee,Source amount",
        "16-Jan-25,Client receipt,250.00",
        "2025-01-17 14:02:01,Fee,-1.50",
        "16 Jan 2025,Duplicate day,10.00",
      ].join("\n"),
    );
    expect(dated.cells.some((cell) => cell.balanceKind === "opening")).toBe(false);
    expect(dated.cells.find((cell) => cell.label === "Client receipt")?.txnDate).toBe("2025-01-16");
    expect(dated.cells.find((cell) => cell.label === "Fee")?.amount).toBe("-1.50");

    const html = await csv(
      "filing.htm",
      [
        "<html><table>",
        "<tr><th>Account</th><th>Year ended December 31, 2025</th></tr>",
        "<tr><td>Revenue</td><td>1,23,456.00</td></tr>",
        "</table></html>",
      ].join(""),
    );
    expect(html.cells.find((cell) => cell.label === "Revenue")).toMatchObject({
      amount: "123456",
      periodEnd: "2025-12-31",
      spanMonths: 12,
    });

    const tally = await csv(
      "profit-and-loss.csv",
      ["Year ended 31 March 2025", "Particulars", ",Debit,Credit", "Sales Accounts,1000.00,"].join(
        "\n",
      ),
    );
    expect(tally.cells.find((cell) => cell.label === "Sales Accounts")).toMatchObject({
      amount: "-1000",
      periodEnd: "2025-03-31",
    });

    const pounds = await csv(
      "profit-and-loss.csv",
      "Statement of profit or loss\n£m\nYear ended 31 December 2025\nAccount,2025\nRevenue,12.50\n",
    );
    expect(pounds.scale).toBe("millions");
    expect(pounds.cells[0]?.periodEnd).toBe("2025-12-31");

    const bytes = renderTextPdf([
      [
        pdfRow([["72", "CONSOLIDATED STATEMENTS OF OPERATIONS"]]),
        pdfRow([["72", "Year ended December 31, 2025"]]),
        pdfRow([
          ["72", "Revenue"],
          ["360", "100.00"],
        ]),
      ],
    ]);
    const operations = await selectDocumentParser("operations.pdf", bytes).parse({
      fileName: "operations.pdf",
      bytes,
    });
    expect(operations.cells.find((cell) => cell.label === "Revenue")?.periodEnd).toBe("2025-12-31");
  });
});
