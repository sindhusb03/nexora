/**
 * Rebuilds synthetic source documents only. Expected outputs are hand-authored
 * in test/accuracy.test.ts. Do not write parser output beside these files.
 * Run from the repo root: pnpm --filter @nexora/api exec tsx test/fixtures/generate-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTextPdf, type PdfTextRow } from "../../src/imports/text-pdf.js";
import { writeXlsx, type XlsxCell } from "../../src/imports/xlsx-write.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "corpus");

interface FixtureSpec {
  readonly id: string;
  readonly fileName: string;
  readonly region: "IN" | "US";
  readonly kind: "statement" | "bank" | "broken";
  readonly bytes: Uint8Array;
}

function grid(rows: readonly (readonly string[])[]): XlsxCell[] {
  const cells: XlsxCell[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (value.length === 0) return;
      const numeric = /^-?\d+(\.\d+)?$/.test(value) && !/^(19|20)\d{2}$/.test(value);
      cells.push({
        row: rowIndex + 1,
        col: colIndex + 1,
        value,
        kind: numeric ? "number" : "string",
      });
    });
  });
  return cells;
}

function sheet(name: string, rows: readonly (readonly string[])[]): Uint8Array {
  return writeXlsx([{ name, cells: grid(rows) }]);
}

function csv(rows: readonly (readonly string[])[]): Uint8Array {
  return new TextEncoder().encode(`${rows.map((row) => row.join(",")).join("\n")}\n`);
}

function pdf(rows: readonly PdfTextRow[]): Uint8Array {
  return renderTextPdf([rows]);
}

function textRow(text: string, x = 72): PdfTextRow {
  return { items: [{ x, text }] };
}

function amountRow(label: string, amount: string): PdfTextRow {
  return {
    items: [
      { x: 72, text: label },
      { x: 400, text: amount },
    ],
  };
}

const specs: readonly FixtureSpec[] = [
  {
    id: "in-tally-pl",
    fileName: "in-tally-pl.xlsx",
    region: "IN",
    kind: "statement",
    bytes: sheet("Profit and Loss", [
      ["Tally P&L", "INR", "Amounts in lakhs"],
      ["Particulars", "2024", "2023"],
      ["Sales Accounts", "1200", "980"],
      ["Cost of Goods Sold", "540", "470"],
      ["Operating Expenses", "210", "180"],
      ["Depreciation", "40", "35"],
      ["Net Income", "410", "295"],
    ]),
  },
  {
    id: "in-schedule-iii-bs",
    fileName: "in-schedule-iii-bs.xlsx",
    region: "IN",
    kind: "statement",
    bytes: sheet("Balance Sheet", [
      ["Schedule III", "INR"],
      ["Particulars", "2024", "2023"],
      ["Cash and Cash Equivalents", "180", "150"],
      ["Trade Receivables", "240", "210"],
      ["Inventories", "90", "80"],
      ["Property Plant and Equipment", "700", "680"],
      ["Trade Payables", "160", "140"],
      ["Borrowings", "300", "320"],
      ["Reserves and Surplus", "750", "660"],
    ]),
  },
  {
    id: "us-quickbooks-pl",
    fileName: "us-quickbooks-pl.xlsx",
    region: "US",
    kind: "statement",
    bytes: sheet("Profit and Loss", [
      ["QuickBooks Profit and Loss", "USD"],
      ["Account", "Jan 2024", "Feb 2024"],
      ["Product Sales", "80000", "84000"],
      ["Cost of Goods Sold", "32000", "33000"],
      ["Payroll Expenses", "22000", "22000"],
      ["Depreciation", "1500", "1500"],
      ["Net Income", "24500", "27500"],
    ]),
  },
  {
    id: "us-quickbooks-bs",
    fileName: "us-quickbooks-bs.xlsx",
    region: "US",
    kind: "statement",
    bytes: sheet("Balance Sheet", [
      ["QuickBooks Balance Sheet", "USD"],
      ["Account", "2024", "2023"],
      ["Checking", "42000", "38000"],
      ["Accounts Receivable", "18000", "16000"],
      ["Inventory Asset", "9000", "8000"],
      ["Accounts Payable", "11000", "10000"],
      ["Retained Earnings", "58000", "52000"],
    ]),
  },
  {
    id: "us-xero-pl",
    fileName: "us-xero-pl.xlsx",
    region: "US",
    kind: "statement",
    bytes: sheet("Profit and Loss", [
      ["Xero Profit and Loss", "USD"],
      ["Account", "Q1 2024", "Q2 2024"],
      ["Revenue", "150000", "162000"],
      ["Cost of Sales", "60000", "64000"],
      ["Operating Expenses", "40000", "41000"],
      ["Net Income", "50000", "57000"],
    ]),
  },
  {
    id: "broken-unbalanced-bs",
    fileName: "broken-unbalanced-bs.xlsx",
    region: "US",
    kind: "broken",
    bytes: sheet("Balance Sheet", [
      ["Broken books", "USD"],
      ["Account", "2024", "2023"],
      ["Cash", "1000", "900"],
      ["Accounts Payable", "200", "180"],
      ["Retained Earnings", "300", "250"],
    ]),
  },
  {
    id: "broken-coverage-gap",
    fileName: "broken-coverage-gap.xlsx",
    region: "US",
    kind: "broken",
    bytes: sheet("Profit and Loss", [
      ["Monthly revenue", "USD"],
      ["Account", "Jan 2024", "Feb 2024", "Apr 2024"],
      ["Revenue", "100", "110", "90"],
      ["Operating Expenses", "40", "40", "40"],
      ["Net Income", "60", "70", "50"],
    ]),
  },
  {
    id: "broken-high-depreciation",
    fileName: "broken-high-depreciation.xlsx",
    region: "IN",
    kind: "broken",
    bytes: sheet("Profit and Loss", [
      ["Depreciation review", "INR"],
      ["Account", "2024", "2023"],
      ["Revenue", "500", "480"],
      ["Depreciation", "900", "20"],
      ["Net Income", "-400", "460"],
    ]),
  },
  {
    id: "ai-explicit-marker",
    fileName: "ai-explicit-marker.xlsx",
    region: "US",
    kind: "statement",
    bytes: sheet("Balance Sheet", [
      ["Marker proposal", "USD"],
      ["Account", "2024", "2023"],
      ["Treasury sweep [ai:cash:0.99]", "500", "400"],
      ["Accounts Payable", "200", "150"],
      ["Retained Earnings", "300", "250"],
    ]),
  },
  {
    id: "ai-low-confidence",
    fileName: "ai-low-confidence.xlsx",
    region: "US",
    kind: "broken",
    bytes: sheet("Profit and Loss", [
      ["Unmapped fee", "USD"],
      ["Account", "2024", "2023"],
      ["Revenue", "200", "180"],
      ["Sundry consulting fee", "30", "20"],
      ["Net Income", "170", "160"],
    ]),
  },
  {
    id: "in-tally-pl-csv",
    fileName: "in-tally-profit-and-loss.csv",
    region: "IN",
    kind: "statement",
    bytes: csv([
      ["Tally export", "INR"],
      ["Particulars", "2024", "2023"],
      ["Sales Accounts", "2500000", "2100000"],
      ["Purchases", "1100000", "900000"],
      ["Indirect Expenses", "400000", "350000"],
      ["Net Profit", "1000000", "850000"],
    ]),
  },
  {
    id: "us-xero-bs-csv",
    fileName: "us-xero-bs.csv",
    region: "US",
    kind: "statement",
    bytes: csv([
      ["Xero Balance Sheet", "USD"],
      ["Account", "2024", "2023"],
      ["Cash", "25000", "22000"],
      ["Accounts Receivable", "8000", "7000"],
      ["Accounts Payable", "6000", "5000"],
      ["Retained Earnings", "27000", "24000"],
    ]),
  },
  {
    id: "in-hdfc-bank",
    fileName: "in-hdfc-bank.csv",
    region: "IN",
    kind: "bank",
    bytes: csv([
      ["HDFC Bank statement", "INR"],
      ["Period 2024-01-01 to 2024-01-31"],
      ["Opening balance 150000.00"],
      ["2024-01-04 NEFT inward customer", "25000.00"],
      ["2024-01-18 IMPS vendor payment", "-8000.00"],
      ["Closing balance 167000.00"],
    ]),
  },
  {
    id: "in-icici-bank",
    fileName: "in-icici-bank.csv",
    region: "IN",
    kind: "bank",
    bytes: csv([
      ["ICICI Bank statement", "INR"],
      ["Period 2024-02-01 to 2024-02-29"],
      ["Opening balance 80000.00"],
      ["2024-02-02 UPI collection", "12000.00"],
      ["2024-02-20 Salary payout", "-30000.00"],
      ["Closing balance 62000.00"],
    ]),
  },
  {
    id: "us-chase-bank",
    fileName: "us-chase-bank.csv",
    region: "US",
    kind: "bank",
    bytes: csv([
      ["Chase Business Complete Checking", "USD"],
      ["Period 2024-03-01 to 2024-03-31"],
      ["Opening balance 22000.00"],
      ["2024-03-05 ACH credit Stripe", "5400.00"],
      ["2024-03-22 Wire out rent", "-3100.00"],
      ["Closing balance 24300.00"],
    ]),
  },
  {
    id: "us-boa-bank",
    fileName: "us-boa-bank.csv",
    region: "US",
    kind: "bank",
    bytes: csv([
      ["Bank of America Business Advantage", "USD"],
      ["Period 2024-04-01 to 2024-04-30"],
      ["Opening balance 15000.00"],
      ["2024-04-03 Deposit", "2000.00"],
      ["2024-04-19 Check 1042", "-750.00"],
      ["Closing balance 16250.00"],
    ]),
  },
  {
    id: "broken-duplicate-txns",
    fileName: "broken-duplicate-txns.csv",
    region: "US",
    kind: "broken",
    bytes: csv([
      ["Chase duplicate export", "USD"],
      ["Period 2024-05-01 to 2024-05-31"],
      ["Opening balance 1000.00"],
      ["2024-05-06 ACH credit", "100.00"],
      ["2024-05-06 ACH credit", "100.00"],
      ["Closing balance 1200.00"],
    ]),
  },
  {
    id: "in-hdfc-bank-pdf",
    fileName: "in-hdfc-bank.pdf",
    region: "IN",
    kind: "bank",
    bytes: pdf([
      textRow("HDFC Bank statement INR"),
      textRow("Period 2024-06-01 to 2024-06-30"),
      textRow("Opening balance 50000.00"),
      textRow("2024-06-07 NEFT inward 4000.00"),
      textRow("2024-06-21 UPI payment -1500.00"),
      textRow("Closing balance 52500.00"),
    ]),
  },
  {
    id: "in-icici-bank-pdf",
    fileName: "in-icici-bank.pdf",
    region: "IN",
    kind: "bank",
    bytes: pdf([
      textRow("ICICI Bank statement INR"),
      textRow("Period 2024-07-01 to 2024-07-31"),
      textRow("Opening balance 9000.00"),
      textRow("2024-07-02 Cash deposit 1000.00"),
      textRow("Closing balance 10000.00"),
    ]),
  },
  {
    id: "us-chase-bank-pdf",
    fileName: "us-chase-bank.pdf",
    region: "US",
    kind: "bank",
    bytes: pdf([
      textRow("Chase statement USD"),
      textRow("Period 2024-08-01 to 2024-08-31"),
      textRow("Opening balance 3000.00"),
      textRow("2024-08-09 ACH credit 500.00"),
      textRow("Closing balance 3500.00"),
    ]),
  },
  {
    id: "us-boa-bank-pdf",
    fileName: "us-boa-bank.pdf",
    region: "US",
    kind: "bank",
    bytes: pdf([
      textRow("Bank of America statement USD"),
      textRow("Period 2024-09-01 to 2024-09-30"),
      textRow("Opening balance 4400.00"),
      textRow("2024-09-12 Check 88 -400.00"),
      textRow("Closing balance 4000.00"),
    ]),
  },
  {
    id: "us-income-statement-pdf",
    fileName: "us-income-statement.pdf",
    region: "US",
    kind: "statement",
    bytes: pdf([
      textRow("For the year ended December 31, 2024"),
      textRow("Income Statement"),
      textRow("USD"),
      amountRow("Revenue", "1,200,000"),
      amountRow("Cost of Goods Sold", "480,000"),
      amountRow("Operating Expenses", "300,000"),
      amountRow("Net Income", "420,000"),
    ]),
  },
  {
    id: "in-balance-sheet-pdf",
    fileName: "in-balance-sheet.pdf",
    region: "IN",
    kind: "statement",
    bytes: pdf([
      textRow("As at December 31, 2024"),
      textRow("Balance Sheet"),
      textRow("INR"),
      amountRow("Cash and Cash Equivalents", "2,500,000"),
      amountRow("Trade Receivables", "1,100,000"),
      amountRow("Trade Payables", "700,000"),
      amountRow("Reserves and Surplus", "2,900,000"),
    ]),
  },
];

mkdirSync(root, { recursive: true });
const index = specs.map((spec) => ({
  id: spec.id,
  fileName: spec.fileName,
  region: spec.region,
  kind: spec.kind,
}));
for (const spec of specs) writeFileSync(join(root, spec.fileName), spec.bytes);
writeFileSync(join(root, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${index.length} source documents`);
