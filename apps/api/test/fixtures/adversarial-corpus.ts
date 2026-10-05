import { renderTextPdf } from "../../src/imports/text-pdf.js";
import { writeXlsx } from "../../src/imports/xlsx-write.js";

// Independently authored generation axes: export layout, market, and format.
// Expected facts below are the source of the documents, never parser output.
export interface Truth {
  label: string;
  amount: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  scale: string;
  statementType: string;
  accountCode: string | null;
  balanceKind: string;
  txnDate: string | null;
}
export interface Fixture {
  id: string;
  family: string;
  fileName: string;
  bytes: Uint8Array;
  cells: Truth[];
}
const markets = [
  ["IN", "INR", "March", "03", "31"],
  ["US", "USD", "December", "12", "31"],
  ["UK", "GBP", "April", "04", "30"],
  ["EU", "EUR", "December", "12", "31"],
  ["SG", "SGD", "September", "09", "30"],
  ["AE", "AED", "December", "12", "31"],
  ["JP", "JPY", "March", "03", "31"],
  ["AU", "AUD", "June", "06", "30"],
] as const;
type Format = "csv" | "xlsx" | "pdf";

export function encodeGrid(
  rows: string[][],
  format: Format,
  name: string,
  numeric = false,
): Uint8Array {
  if (format === "csv")
    return new TextEncoder().encode(
      rows.map((row) => row.map((s) => `"${s.replace(/"/g, '""')}"`).join(";")).join("\n"),
    );
  if (format === "xlsx")
    return writeXlsx([
      {
        name,
        cells: rows.flatMap((row, r) =>
          row.map((value, c) => ({
            row: r + 1,
            col: c + 1,
            value,
            kind: numeric && /^\d+$/.test(value) ? ("number" as const) : ("string" as const),
          })),
        ),
      },
    ]);
  return renderTextPdf([
    rows.map((row) => ({
      items: row.map((text, c) => ({ x: c === 0 ? 28 : 260 + (c - 1) * 85, text })),
    })),
  ]);
}

export function adversarialCorpus(): Fixture[] {
  const fixtures: Fixture[] = [];
  markets.forEach(([market, currency, month, mm, day], mi) => {
    for (let style = 0; style < 3; style++) {
      const format: Format = (["csv", "xlsx", "pdf"] as const)[(mi + style) % 3]!;
      for (const family of ["income", "balance", "bank"] as const) {
        const id = `${market}-${family}-${style}-${format}`;
        const fileName = `${id}.${format}`;
        if (family === "bank") {
          const header =
            style === 0
              ? ["Date", "Details", "Amount", "Balance"]
              : style === 1
                ? ["Date", "Details", "Paid out", "Paid in", "Balance"]
                : ["Date", "Details", "Amount", "Dr/Cr", "Balance"];
          const start = "2025-08-01",
            end = "2025-08-31";
          const data =
            style === 0
              ? [
                  [start, "Opening balance", "", "1600.00"],
                  ["2025-08-14", "Settlement", "280.00", "1880.00"],
                  ["2025-08-22", "Service fee", "-13.00", "1867.00"],
                  [end, "Closing balance", "", "1867.00"],
                ]
              : style === 1
                ? [
                    [start, "Opening balance", "", "", "1600.00"],
                    ["2025-08-14", "Settlement", "", "280.00", "1880.00"],
                    ["2025-08-22", "Service fee", "13.00", "", "1867.00"],
                    [end, "Closing balance", "", "", "1867.00"],
                  ]
                : [
                    [start, "Opening balance", "", "", "1600.00"],
                    ["2025-08-14", "Settlement", "280.00", "CR", "1880.00"],
                    ["2025-08-22", "Service fee", "13.00", "DR", "1867.00"],
                    [end, "Closing balance", "", "", "1867.00"],
                  ];
          fixtures.push({
            id,
            family: `${family}/${format}`,
            fileName,
            bytes: encodeGrid(
              [[`${currency} account activity`], ["Customer reference 81007"], header, ...data],
              format,
              "Bank",
            ),
            cells: [
              ["Opening balance", "1600", "opening", null],
              ["Closing balance", "1867", "closing", null],
              ["Settlement", "280", "movement", "2025-08-14"],
              ["Service fee", "-13", "movement", "2025-08-22"],
            ].map(([label, amount, balanceKind, txnDate]) => ({
              label: label!,
              amount: amount!,
              balanceKind: balanceKind!,
              txnDate: txnDate ?? null,
              periodStart: start,
              periodEnd: end,
              currency,
              scale: "units",
              statementType: "bank",
              accountCode: null,
            })),
          });
          continue;
        }
        const labels =
          family === "income"
            ? ["Revenue", "Cost of sales", "Operating expenses", "Net income"]
            : [
                "Cash",
                "Accounts receivable",
                "Accounts payable",
                "Common stock",
                "Retained earnings",
              ];
        const codes =
          family === "income"
            ? ["revenue", "cogs", "operating_expenses", "net_income"]
            : [
                "cash",
                "accounts_receivable",
                "accounts_payable",
                "common_stock",
                "retained_earnings",
              ];
        const amounts =
          family === "income"
            ? ["7520", "1830", "2070", "3620"]
            : ["3700", "1210", "910", "2200", "1800"];
        // Unknown language and explicit qualifiers stay extractable but unmapped.
        if (market === "JP" && format !== "pdf") {
          labels[1] = "その他の費用";
          codes[1] = "";
        }
        if (style === 2) {
          labels[0] += " (net of adjustments)";
          codes[0] = "";
        }
        const years = style === 1 ? [2024, 2025] : [2025, 2024];
        const scale = style === 1 ? "thousands" : style === 2 ? "millions" : "units";
        const rows: string[][] = [
          [`${family === "income" ? "Income statement" : "Balance sheet"} ${currency}`],
          ["Prepared on 19 September 2026"],
          [`Year ended ${day} ${month} 2025`],
          [`Amounts in ${scale}`],
        ];
        if (style === 0 && format !== "pdf")
          for (let n = 0; n < 27; n++)
            rows.push([`Report parameter ${String.fromCharCode(65 + (n % 26))}`]);
        rows.push(
          style === 2
            ? ["Account", "Notes", ...years.map((y) => `${day} ${month} ${y}`)]
            : ["Account", ...years.map(String)],
        );
        const cells: Truth[] = [];
        labels.forEach((label, i) => {
          const values = years.map((year) =>
            String(BigInt(amounts[i]!) - (year === 2024 ? 130n : 0n)),
          );
          const printed = values.map((v) =>
            market === "EU" ? `${v},00` : style === 1 ? `${v}.00` : v,
          );
          rows.push(style === 2 ? [label, String(i + 1), ...printed] : [label, ...printed]);
          years.forEach((year, j) => {
            const start =
              mm === "12"
                ? `${year}-01-01`
                : `${year - 1}-${String(Number(mm) + 1).padStart(2, "0")}-01`;
            cells.push({
              label,
              amount: values[j]!,
              periodStart: start,
              periodEnd: `${year}-${mm}-${day}`,
              currency,
              scale,
              statementType: family === "income" ? "income_statement" : "balance_sheet",
              accountCode: codes[i] || null,
              balanceKind: family === "income" ? "movement" : "closing",
              txnDate: null,
            });
          });
        });
        fixtures.push({
          id,
          family: `${family}/${format}`,
          fileName,
          bytes: encodeGrid(rows, format, family === "income" ? "Income" : "Balance", style === 1),
          cells,
        });
      }
    }
  });
  return fixtures;
}
