import { describe, expect, it } from "vitest";

import { selectDocumentParser } from "../src/imports/document-parser.js";
import { renderTextPdf, type PdfTextRow } from "../src/imports/text-pdf.js";
import { writeXlsx } from "../src/imports/xlsx-write.js";
import { ingestionUploadConflict } from "../src/ingestion/service.js";

function csv(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return selectDocumentParser(name, bytes).parse({ fileName: name, bytes });
}

function row(items: readonly (readonly [string, string])[]): PdfTextRow {
  return { items: items.map(([x, text]) => ({ x: Number(x), text })) };
}

describe("extraction families dev set", () => {
  it("reads three bank layouts from headers or column content", async () => {
    const hdfc = await csv(
      "bank.csv",
      [
        "Value Date,Particulars,Ref,Withdrawal,Deposit,Balance",
        "15/06/2025,Opening balance,N1,,,1000.00",
        "16/06/2025,Customer receipt,N2,,250.00,1250.00",
      ].join("\n"),
    );
    expect(hdfc.cells.find((cell) => cell.label === "Customer receipt")?.amount).toBe("250.00");
    expect(hdfc.cells.find((cell) => cell.balanceKind === "movement")?.txnDate).toBe("2025-06-16");

    const signed = await csv(
      "bank.csv",
      [
        "Date,Description,Amount,Balance",
        "03/22/2025,Opening,,500.00",
        "03/23/2025,Card purchase,-40.00,460.00",
      ].join("\n"),
    );
    expect(signed.cells.find((cell) => cell.label === "Card purchase")?.amount).toBe("-40.00");
    expect(signed.cells.find((cell) => cell.balanceKind === "movement")?.txnDate).toBe(
      "2025-03-23",
    );

    const drcr = await csv(
      "bank.csv",
      [
        "Posting Date,Narrative,Money out,Money in,Running balance",
        "2025-01-15,Opening,,,800.00",
        "2025-01-16,Supplier,75.00,,725.00",
      ].join("\n"),
    );
    expect(drcr.cells.find((cell) => cell.label === "Supplier")?.amount).toBe("-75.00");
    expect(drcr.issues.some((issue) => issue.code === "balance_mismatch")).toBe(false);
  });

  it("reads Schedule III, IFRS, and Tally grids", async () => {
    const schedule = await csv(
      "balance-sheet.csv",
      [
        "Particulars,Note No,As at 31 March 2025,As at 31 March 2024",
        'Cash and cash equivalents,12,"1,50,000.00","1,20,000.00"',
      ].join("\n"),
    );
    expect(schedule.cells.find((cell) => cell.periodEnd === "2025-03-31")?.amount).toBe(
      "150000.00",
    );
    expect(schedule.issues.some((issue) => issue.code === "layout_unresolved")).toBe(false);

    const multi = await csv(
      "balance-sheet.csv",
      [
        " ,As at,As at",
        "Particulars,31 March 2025,31 March 2024",
        'Inventories,"10.00","8.00"',
      ].join("\n"),
    );
    expect(
      multi.cells.some((cell) => cell.label === "Inventories" && cell.amount === "10.00"),
    ).toBe(true);

    const lakhs = await csv(
      "balance-sheet.csv",
      [
        "Statement of financial position",
        "Rs in lakhs",
        "Particulars,31 March 2025",
        'Trade receivables,"1,23,456.00"',
      ].join("\n"),
    );
    expect(lakhs.scale).toBe("lakhs");
    expect(lakhs.cells[0]?.amount).toBe("123456.00");

    const ifrs = await csv(
      "balance-sheet.csv",
      [
        "Consolidated statement of financial position",
        "Notes,31 December 2025,31 December 2024",
        'Cash,"(1,000.00)","900.00"',
      ].join("\n"),
    );
    expect(ifrs.cells.find((cell) => cell.periodEnd.startsWith("2025-12-31"))?.amount).toBe(
      "-1000.00",
    );

    const thousands = await csv(
      "profit-and-loss.csv",
      ["Statement of profit or loss", "in thousands", " ,2025", 'Revenue,"2,500.00"'].join("\n"),
    );
    expect(thousands.scale).toBe("thousands");
    expect(thousands.issues.some((issue) => issue.code === "confirm_period_end")).toBe(true);

    const ifrsDated = await csv(
      "profit-and-loss.csv",
      [
        "Statement of profit or loss",
        "Year ended 30 September 2024",
        "in thousands",
        "Account,2024",
        "Revenue,80.00",
      ].join("\n"),
    );
    expect(ifrsDated.cells.find((cell) => cell.label === "Revenue")?.periodEnd).toBe("2024-09-30");

    const tally = await csv(
      "profit-and-loss.csv",
      [
        "Tally P&L",
        "Year ended 30 June 2025",
        "Particulars,Debit,Credit",
        "Sales,,1000.00",
        "Purchases,400.00,",
      ].join("\n"),
    );
    expect(tally.cells.find((cell) => cell.label === "Sales")?.amount).toBe("1000");
    expect(tally.cells.find((cell) => cell.label === "Sales")?.periodEnd).toBe("2025-06-30");
    expect(tally.cells.find((cell) => cell.label === "Purchases")?.amount).toBe("400");

    const tallyAmount = await csv(
      "balance-sheet.csv",
      ["Trial Balance", "as at 31 March 2025", "Account,Closing Balance", "Cash,250.00"].join("\n"),
    );
    expect(tallyAmount.cells.find((cell) => cell.label === "Cash")?.periodEnd).toBe("2025-03-31");

    const bytes = writeXlsx([
      {
        name: "Profit and Loss",
        cells: [
          { row: 1, col: 1, value: "Year ended 31 December 2024", kind: "string" },
          { row: 2, col: 1, value: "Particulars", kind: "string" },
          { row: 2, col: 2, value: "Amount", kind: "string" },
          { row: 3, col: 1, value: "Revenue", kind: "string" },
          { row: 3, col: 2, value: "640.00", kind: "number" },
        ],
      },
    ]);
    const tallyXlsx = await selectDocumentParser("profit-and-loss.xlsx", bytes).parse({
      fileName: "profit-and-loss.xlsx",
      bytes,
    });
    expect(tallyXlsx.cells.find((cell) => cell.label === "Revenue")?.amount).toBe("640");
  });

  it("clusters PDF text by x position and routes a textless file to review", async () => {
    const incomeBytes = renderTextPdf([
      [
        row([["72", "Condensed consolidated income statement"]]),
        row([["72", "Year ended 30 June 2025"]]),
        row([
          ["72", "Revenue"],
          ["360", "100.00"],
        ]),
        row([
          ["72", "Cost of sales"],
          ["360", "(40.00)"],
        ]),
      ],
    ]);
    const income = await selectDocumentParser("income.pdf", incomeBytes).parse({
      fileName: "income.pdf",
      bytes: incomeBytes,
    });
    expect(income.cells.map((cell) => cell.label).sort()).toEqual(["Cost of sales", "Revenue"]);
    expect(income.cells.find((cell) => cell.label === "Revenue")?.periodEnd).toBe("2025-06-30");

    const balanceBytes = renderTextPdf([
      [
        row([["40", "Condensed Consolidated Balance Sheets"]]),
        row([
          ["220", "31 December 2025"],
          ["400", "31 December 2024"],
        ]),
        row([
          ["40", "Cash"],
          ["220", "15.00"],
          ["400", "12.00"],
        ]),
      ],
    ]);
    const balance = await selectDocumentParser("balance.pdf", balanceBytes).parse({
      fileName: "balance.pdf",
      bytes: balanceBytes,
    });
    expect(balance.cells.filter((cell) => cell.label === "Cash")).toHaveLength(2);

    const equityBytes = renderTextPdf([
      [
        row([["40", "Statement of changes in equity"]]),
        row([["40", "Year ended 31 March 2025"]]),
        row([
          ["40", "Share capital"],
          ["320", "50.00"],
        ]),
      ],
    ]);
    const equity = await selectDocumentParser("equity.pdf", equityBytes).parse({
      fileName: "equity.pdf",
      bytes: equityBytes,
    });
    expect(equity.cells[0]?.label).toBe("Share capital");
    expect(equity.cells[0]?.periodEnd).toBe("2025-03-31");

    const blank = renderTextPdf([[]]);
    const scanned = await selectDocumentParser("scanned.pdf", blank).parse({
      fileName: "scanned.pdf",
      bytes: blank,
    });
    expect(scanned.cells).toEqual([]);
    expect(scanned.issues.some((issue) => issue.code === "layout_unresolved")).toBe(true);
  });

  it("maps a unique-constraint failure to a conflict error", () => {
    const error = ingestionUploadConflict({ code: "23505" });
    expect(error?.code).toBe("FIN_IDEMPOTENCY_MISMATCH");
    expect(error?.message.toLowerCase()).not.toContain("duplicate key");
    expect(ingestionUploadConflict(new Error("network"))).toBeNull();
  });
});
