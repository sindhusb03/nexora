import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { encodeGrid } from "./adversarial-corpus.js";
import { renderTextPdf } from "../../src/imports/text-pdf.js";

export interface Round1Fixture {
  id: string;
  family: string;
  fileName: string;
  bytes: Uint8Array;
  functionalCurrency: string;
  expected: { label: string; minor: string; currency: string; end: string; date: string | null }[];
}

// Small, independently authored styles, with truth specified before encoding.
export function round1Corpus(): Round1Fixture[] {
  const fixtures: Round1Fixture[] = [];
  function add(
    id: string,
    family: string,
    rows: string[][],
    currency: string,
    facts: [string, string, string, (string | null)?][],
    format: "csv" | "xlsx" | "pdf" = "csv",
  ) {
    const fixture: Round1Fixture = {
      id,
      family,
      fileName: `${id}.${format}`,
      bytes: encodeGrid(rows, format, family.includes("bank") ? "Activity" : "Profit and loss"),
      functionalCurrency: currency,
      expected: facts.map(([label, minor, end, date]) => ({
        label,
        minor,
        currency,
        end,
        date: date ?? null,
      })),
    };
    fixtures.push(fixture);
    return fixture;
  }
  for (const [i, evidence, revenue, expense] of [
    [0, "Locale de-DE", "73.219", "21.105"],
    [1, "", "73.219", "21.105,00"],
    [2, "", "1.073.219", "21.105"],
  ] as const) {
    add(
      `grouped-${i}`,
      "number-convention",
      [
        ["Income statement EUR in thousand", evidence],
        ["Year ended 31 December 2025"],
        ["Account", "2025"],
        ["Revenue", revenue],
        ["Operating expenses", expense],
      ],
      "EUR",
      [
        ["Revenue", i === 2 ? "107321900000" : "7321900000", "2025-12-31"],
        ["Operating expenses", "2110500000", "2025-12-31"],
      ],
      i === 2 ? "xlsx" : "csv",
    );
  }
  add(
    "ambiguous-dot",
    "review",
    [
      ["Income statement EUR in thousand"],
      ["Year ended 31 December 2025"],
      ["Account", "2025"],
      ["Revenue", "73.219"],
    ],
    "EUR",
    [],
  );
  add(
    "mixed-convention",
    "review",
    [
      ["Income statement EUR"],
      ["Year ended 31 December 2025"],
      ["Account", "2025"],
      ["Revenue", "123,45"],
      ["Rent", "20.50"],
    ],
    "EUR",
    [],
  );
  const mixedNative = add(
    "native-and-text",
    "number-convention",
    [
      ["Income statement EUR in thousand, locale de-DE"],
      ["Year ended 31 December 2025"],
      ["Account", "2025"],
      ["Revenue", "73.219"],
      ["Operating expenses", "73.219"],
    ],
    "EUR",
    [
      ["Revenue", "7321900", "2025-12-31"],
      ["Operating expenses", "7321900000", "2025-12-31"],
    ],
    "xlsx",
  );
  const nativeFiles = unzipSync(mixedNative.bytes);
  nativeFiles["xl/worksheets/sheet1.xml"] = strToU8(
    strFromU8(nativeFiles["xl/worksheets/sheet1.xml"]!).replace(
      '<c r="B4" t="inlineStr"><is><t>73.219</t></is></c>',
      '<c r="B4"><v>73.219</v></c>',
    ),
  );
  mixedNative.bytes = zipSync(nativeFiles);
  const html = add("html-grouped", "number-convention", [], "EUR", [
    ["Revenue", "7321900000", "2025-12-31"],
  ]);
  html.fileName = "html-grouped.htm";
  html.bytes = new TextEncoder().encode(
    "<html><p>Income statement EUR in thousand Locale de-DE</p><p>Year ended 31 December 2025</p><table><tr><th>Account</th><th>2025</th></tr><tr><td>Revenue</td><td>73.219</td></tr></table></html>",
  );
  for (const cue of ["S$", "Statement currency AUD S$"]) {
    add(
      `conflict-${cue}`,
      "review",
      [
        [`Income statement ${cue}`],
        ["Year ended 31 December 2025"],
        ["Account", "2025"],
        ["Revenue", "625.00"],
      ],
      "AUD",
      [],
    );
  }
  for (const [i, date, debit, credit, balance] of [
    [0, "Tran Date", "DR", "CR", "BAL"],
    [1, "Transaction Date", "Withdrawal (Dr)", "Deposit (Cr)", "Balance"],
    [2, "Booking date", "Paid out", "Paid in", "Running balance"],
  ] as const) {
    const rows = [
      ["Account currency INR"],
      ["Customer reference 7291"],
      [date, "CHQNO", "PARTICULARS", debit, credit, balance],
      ["", "", "Balance Brought Forward", "", "", "3500.00"],
      ["18/07/2025", "17", "Receipt", "", "620.00", "4120.00"],
      ["21/07/2025", "18", "Rent", "230.00", "", "3890.00"],
    ];
    const f = add(
      `bank-india-${i}`,
      "bank-columns",
      rows,
      "INR",
      [
        ["Opening balance", "350000", "2025-07-21"],
        ["Closing balance", "389000", "2025-07-21"],
        ["Receipt", "62000", "2025-07-21", "2025-07-18"],
        ["Rent", "-23000", "2025-07-21", "2025-07-21"],
      ],
      i === 0 ? "csv" : "pdf",
    );
    if (i > 0)
      f.bytes = renderTextPdf([
        rows.map((row) => ({
          items: row.map((text, c) => ({ x: [24, 100, 160, 340, 430, 520][c]!, text })),
        })),
      ]);
  }
  for (const [i, posting] of [
    [0, "Completed Date"],
    [1, "Value Date"],
    [2, "Booked Date"],
  ] as const) {
    add(
      `fees-${i}`,
      "bank-fees-dates-currency",
      [
        ["Account currency GBP"],
        ["Started Date", posting, "Description", "Amount", "Fee", "Balance"],
        ["2025-06-01", "2025-06-02", "Opening balance", "", "", "1000.00"],
        ["2025-06-03", "2025-06-05", "USD conversion receipt", "200.00", "3.00", "1197.00"],
        ["2025-06-04", "2025-06-06", "Supplier", "-100.00", "2.00", "1095.00"],
      ],
      "GBP",
      [
        ["Opening balance", "100000", "2025-06-06"],
        ["Closing balance", "109500", "2025-06-06"],
        ["USD conversion receipt", "19700", "2025-06-06", "2025-06-05"],
        ["Supplier", "-10200", "2025-06-06", "2025-06-06"],
      ],
    );
  }
  for (const currency of ["EUR", "AUD"]) {
    const rowCurrency = add(
      `row-currency-${currency}`,
      "bank-currency-column",
      [
        ["Account activity"],
        ["Completed Date", "Description", "Amount", "Fee", "Currency", "Balance"],
        ["2025-06-01", "Opening balance", "", "", currency, "900.00"],
        ["2025-06-02", "CAD conversion", "100.00", "2.00", currency, "998.00"],
      ],
      currency,
      [
        ["Opening balance", "90000", "2025-06-02"],
        ["Closing balance", "99800", "2025-06-02"],
        ["CAD conversion", "9800", "2025-06-02", "2025-06-02"],
      ],
    );
    rowCurrency.functionalCurrency = "USD";
  }
  add(
    "mixed-row-currency",
    "review",
    [
      ["Account activity"],
      ["Date", "Description", "Amount", "Currency", "Balance"],
      ["2025-06-01", "Opening balance", "", "GBP", "900.00"],
      ["2025-06-02", "Receipt", "100.00", "EUR", "1000.00"],
    ],
    "USD",
    [],
  );
  for (const [i, currency] of [
    [0, "AED"],
    [1, "SGD"],
  ] as const) {
    const f = add(
      `serial-bank-${i}`,
      "bank-excel-dates",
      [
        [`Statement currency ${currency}`],
        ["Value Date", "Description", "Amount", "Balance"],
        ["45839", "Balance brought forward", "", "1500"],
        ["45840", "Settlement", "350 Cr", "1850"],
        ["45841", "Transfer", "125 Dr", "1725"],
      ],
      currency,
      [
        ["Opening balance", "150000", "2025-07-03"],
        ["Closing balance", "172500", "2025-07-03"],
        ["Settlement", "35000", "2025-07-03", "2025-07-02"],
        ["Transfer", "-12500", "2025-07-03", "2025-07-03"],
      ],
      "xlsx",
    );
    const files = unzipSync(f.bytes);
    files["xl/styles.xml"] = strToU8(
      '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    );
    files["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(
        /<c r="A([345])"[^>]*><is><t>(\d+)<\/t><\/is><\/c>/g,
        '<c r="A$1" s="1"><v>$2</v></c>',
      ),
    );
    f.bytes = zipSync(files);
  }
  for (const [i, range] of [
    [0, "From 01/04/2024 To 31/03/2025"],
    [1, "From 07/01/2024 To 06/30/2025"],
    [2, "2024-01-01 to 2024-12-31"],
  ] as const) {
    const end = ["2025-03-31", "2025-06-30", "2024-12-31"][i]!;
    add(
      `range-total-${i}`,
      "statement-range",
      [
        ["Profit and loss USD"],
        [range],
        ["Account", "Total"],
        ["Revenue", "9150"],
        ["Operating expenses", "2150"],
      ],
      "USD",
      [
        ["Revenue", "915000", end],
        ["Operating expenses", "215000", end],
      ],
      "xlsx",
    );
  }
  for (const [i, scale, minor] of [
    [0, "（単位：百万円）", "92000000"],
    [1, "単位：千円", "92000"],
  ] as const) {
    add(
      `japan-${i}`,
      "statement-bilingual",
      [
        [`損益計算書 Profit and loss JPY ${scale}`],
        ["Year ended 31 March 2025"],
        ["勘定科目 Account", "2024", "2025"],
        ["売上高 Revenue", "92", "103"],
      ],
      "JPY",
      [
        ["売上高 Revenue", minor, "2024-03-31"],
        ["売上高 Revenue", i === 0 ? "103000000" : "103000", "2025-03-31"],
      ],
      "xlsx",
    );
  }
  for (const [i, offset] of [
    [0, 0],
    [1, 1],
  ] as const) {
    const rows = [
      ["Income statement USD"],
      ["Year ended 31 December 2025"],
      ["Account", "", "", "2025", ""],
      ["Revenue", "", "", "", "7210"],
    ].map((row) => [...Array<string>(offset).fill(""), ...row]);
    const f = add(
      `merged-${i}`,
      "statement-merged",
      rows,
      "USD",
      [["Revenue", "721000", "2025-12-31"]],
      "xlsx",
    );
    const files = unzipSync(f.bytes);
    const refs = i === 0 ? ["A1:E1", "A4:B4", "D3:E3"] : ["B1:F1", "B4:C4", "E3:F3"];
    files["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(
        "</worksheet>",
        `<mergeCells>${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells></worksheet>`,
      ),
    );
    f.bytes = zipSync(files);
  }
  for (const currency of ["AUD", "CAD", "SGD"]) {
    add(
      `shared-symbol-${currency}`,
      "currency",
      [
        ["Income statement $"],
        ["Year ended 31 December 2025"],
        ["Account", "2025"],
        ["Revenue", "$625.00"],
      ],
      currency,
      [["Revenue", "62500", "2025-12-31"]],
    );
  }
  add(
    "currency-conflict",
    "review",
    [
      ["Statement currency EUR USD"],
      ["Income statement"],
      ["Year ended 31 December 2025"],
      ["Account", "2025"],
      ["Revenue", "625.00"],
    ],
    "EUR",
    [],
  );
  return fixtures;
}
