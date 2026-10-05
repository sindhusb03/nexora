import { encodeGrid } from "./adversarial-corpus.js";
import { renderTextPdf } from "../../src/imports/text-pdf.js";

type Fact = [label: string, amount: string, date: string | null];
export interface BankGolden {
  id: string;
  fileName: string;
  bytes: Uint8Array;
  currency: string;
  facts: Fact[];
  issue?: "ambiguous_date" | "balance_mismatch" | "layout_unresolved" | "dropped_amount";
}

// Invented exports, independent literal truth. No institution/fixture-name dispatch.
// Encoding runs on every test: CSV, real OOXML, and real text-layer PDF bytes.
export function bankRound3aCorpus(): BankGolden[] {
  const fixtures: BankGolden[] = [];
  const add = (
    id: string,
    format: "csv" | "xlsx" | "pdf",
    currency: string,
    rows: string[][],
    facts: Fact[],
    issue?: BankGolden["issue"],
  ) => {
    const fixture: BankGolden = {
      id,
      fileName: `${id}.${format}`,
      currency,
      bytes: encodeGrid(rows, format, "Activity"),
      facts,
      ...(issue ? { issue } : {}),
    };
    fixtures.push(fixture);
    return fixture;
  };
  add(
    "local-settlement",
    "csv",
    "INR",
    [
      ["Account currency INR"],
      ["Date", "Description", "Amount", "Local amount", "Balance"],
      ["", "Opening Balance", "", "", "1,23,456.78"],
      ["17-06-2025", "Tools", "-14.00", "456.78 Dr", "1,23,000.00"],
      ["18-06-2025", "Refund", "2.00", "100.00 Cr", "1,23,100.00"],
      ["Closing Bal", "", "", "", "1,23,100.00"],
    ],
    [
      ["Opening balance", "123456.78", null],
      ["Closing balance", "123100", null],
      ["Tools", "-456.78", "2025-06-17"],
      ["Refund", "100", "2025-06-18"],
    ],
  );
  add(
    "paired-with-fx",
    "xlsx",
    "EUR",
    [
      ["Account currency EUR"],
      [
        "Date",
        "Details",
        "Money out",
        "Money in",
        "Amount (EUR)",
        "Amount (Foreign Currency)",
        "Balance",
      ],
      ["", "Opening Balance", "", "", "", "", "800.00"],
      ["2025-07-16", "License", "24.25", "", "-24.25", "-28.00", "775.75"],
      ["2025-07-18", "Rebate", "", "4.50", "4.50", "5.00", "780.25"],
      ["Total", "", "24.25", "4.50"],
      ["Transaction count", "2"],
    ],
    [
      ["Opening balance", "800", null],
      ["Closing balance", "780.25", null],
      ["License", "-24.25", "2025-07-16"],
      ["Rebate", "4.5", "2025-07-18"],
    ],
  );
  add(
    "hyphen-month-first",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Balance"],
      ["Opening Balance", "1000.00"],
      ["08-09-2025", "Supplies", "(12.35)", "987.65"],
      ["08-20-2025", "Adjustment", "2.35", "990.00"],
      ["Total Debits", "12.35"],
      ["Credits", "2.35"],
      ["Closing Bal", "990.00"],
    ],
    [
      ["Opening balance", "1000", null],
      ["Closing balance", "990", null],
      ["Supplies", "-12.35", "2025-08-09"],
      ["Adjustment", "2.35", "2025-08-20"],
    ],
  );
  const rollover = add(
    "year-boundary",
    "pdf",
    "GBP",
    [],
    [
      ["Opening balance", "300", null],
      ["Closing balance", "315.2", null],
      ["Transfer invoice settlement", "20", "2025-12-29"],
      ["Postage", "-4.8", "2026-01-03"],
    ],
  );
  const pdfRows = (rows: string[][]) =>
    rows.map((row) => ({ items: row.map((text, c) => ({ text, x: [28, 150, 365, 475][c]! })) }));
  rollover.bytes = renderTextPdf([
    pdfRows([
      ["Account currency GBP"],
      ["Statement period 20 December 2025 to 10 January 2026"],
      ["Date", "Details", "Amount", "Balance"],
      ["", "Brought forward", "", "300.00"],
      ["29 DEC", "Transfer", "20.00 Cr", "320.00"],
      ["", "invoice settlement"],
    ]),
    pdfRows([
      ["Date", "Details", "Amount", "Balance"],
      ["03 JAN", "Postage", "4.80-", "315.20"],
      ["", "Closing Bal", "", "315.20"],
    ]),
  ]);
  add(
    "named-day",
    "xlsx",
    "SGD",
    [
      ["Account currency SGD"],
      ["Statement period: 2025-06-01 to 2025-06-30"],
      ["Posting Date", "Narration", "Amount", "Dr/Cr", "Balance"],
      ["", "Opening balance", "", "", "90.00"],
      ["03 JUN", "Hosting", "8.20", "DR", "81.80"],
      ["05 JUN", "Receipt", "16.40", "CR", "98.20"],
    ],
    [
      ["Opening balance", "90", null],
      ["Closing balance", "98.2", null],
      ["Hosting", "-8.2", "2025-06-03"],
      ["Receipt", "16.4", "2025-06-05"],
    ],
  );
  add(
    "locale-direction",
    "csv",
    "AED",
    [
      ["Account currency AED", "Locale en-GB"],
      ["Date", "Particulars", "Withdrawal", "Deposit", "Balance"],
      ["", "Opening balance", "", "", "600.00"],
      ["04/06/2025", "Taxi", "20.00", "", "580.00"],
      ["05/06/2025", "Reimbursement", "", "30.00", "610.00"],
    ],
    [
      ["Opening balance", "600", null],
      ["Closing balance", "610", null],
      ["Taxi", "-20", "2025-06-04"],
      ["Reimbursement", "30", "2025-06-05"],
    ],
  );
  add(
    "integer-yen",
    "xlsx",
    "JPY",
    [
      ["Account currency JPY"],
      ["Date", "Details", "Amount", "Balance"],
      ["", "Opening balance", "", "20000"],
      ["2025-09-15", "Freight", "1200 DR", "18800"],
      ["2025-09-16", "Receipt", "3000 CR", "21800"],
      ["Total Debits", "1200"],
      ["Total Credits", "3000"],
    ],
    [
      ["Opening balance", "20000", null],
      ["Closing balance", "21800", null],
      ["Freight", "-1200", "2025-09-15"],
      ["Receipt", "3000", "2025-09-16"],
    ],
  );
  add(
    "currency-date-cue",
    "csv",
    "AUD",
    [
      ["Account currency AUD"],
      ["Date", "Description", "Amount", "Balance"],
      ["", "Opening balance", "", "80.00"],
      ["02/07/2025", "Parking", "3.20-", "76.80"],
      ["03/07/2025", "Refund", "1.20", "78.00"],
      ["Number of transactions", "2"],
    ],
    [
      ["Opening balance", "80", null],
      ["Closing balance", "78", null],
      ["Parking", "-3.2", "2025-07-02"],
      ["Refund", "1.2", "2025-07-03"],
    ],
  );
  add(
    "explicit-denominations",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Description", "Amount (JPY)", "Amount (USD)", "Balance"],
      ["", "Opening balance", "", "", "500.00"],
      ["2025-10-14", "Parts", "-1500", "-10.25", "489.75"],
    ],
    [
      ["Opening balance", "500", null],
      ["Closing balance", "489.75", null],
      ["Parts", "-10.25", "2025-10-14"],
    ],
  );
  add(
    "monotonic-evidence",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Description", "Amount", "Balance"],
      ["", "Opening balance", "", "200.00"],
      ["11/02/2025", "One", "1.00", "201.00"],
      ["12/01/2025", "Two", "2.00", "203.00"],
      ["12/03/2025", "Three", "3.00", "206.00"],
    ],
    [
      ["Opening balance", "200", null],
      ["Closing balance", "206", null],
      ["One", "1", "2025-11-02"],
      ["Two", "2", "2025-12-01"],
      ["Three", "3", "2025-12-03"],
    ],
  );
  add(
    "reverse-chronology",
    "xlsx",
    "GBP",
    [
      ["Account currency GBP"],
      ["Opening Balance", "70.00"],
      ["Closing Balance", "75.00"],
      ["Date", "Details", "Debit", "Credit", "Balance"],
      ["2025-11-22", "Charge", "5.00", "", "75.00"],
      ["2025-11-20", "Receipt", "", "10.00", "80.00"],
    ],
    [
      ["Opening balance", "70", null],
      ["Closing balance", "75", null],
      ["Charge", "-5", "2025-11-22"],
      ["Receipt", "10", "2025-11-20"],
    ],
  );
  const trapRows = (date = "2025-08-15", balance = "90.00", footer = "10.00") => [
    ["Account currency USD"],
    ["Date", "Details", "Amount", "Balance"],
    ["", "Opening balance", "", "100.00"],
    [date, "Purchase", "-10.00", balance],
    ["Total Debits", footer],
    ["Closing Bal", "90.00"],
  ];
  const heldFacts: Fact[] = [
    ["Opening balance", "100", null],
    ["Closing balance", "90", null],
    ["Purchase", "-10", "2025-08-15"],
  ];
  add("trap-date-order", "csv", "USD", trapRows("04/05/2025"), [], "ambiguous_date");
  add(
    "trap-running-balance",
    "xlsx",
    "USD",
    trapRows("2025-08-15", "91.00"),
    heldFacts,
    "balance_mismatch",
  );
  add(
    "trap-footer-total",
    "pdf",
    "USD",
    trapRows("2025-08-15", "90.00", "11.00"),
    heldFacts,
    "balance_mismatch",
  );
  add("trap-missing-year", "csv", "USD", trapRows("03 JUN"), [], "ambiguous_date");
  add(
    "trap-count",
    "csv",
    "USD",
    [...trapRows(), ["Transaction count", "2"]],
    heldFacts,
    "balance_mismatch",
  );
  add(
    "trap-duplicate-role",
    "xlsx",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Amount", "Balance"],
      ["", "Opening balance", "", "", "100.00"],
      ["2025-08-15", "Purchase", "-10.00", "-11.00", "90.00"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "trap-redundant-disagreement",
    "csv",
    "EUR",
    [
      ["Account currency EUR"],
      ["Date", "Details", "Debit", "Credit", "Amount (EUR)", "Balance"],
      ["", "Opening balance", "", "", "", "100.00"],
      ["2025-08-15", "Purchase", "10.00", "", "-11.00", "90.00"],
    ],
    [["Opening balance", "100", null]],
    "dropped_amount",
  );
  add(
    "trap-conflicting-date-evidence",
    "csv",
    "USD",
    [
      ...trapRows(),
      ["23/08/2025", "Receipt", "1.00", "91.00"],
      ["08/24/2025", "Fee", "-1.00", "90.00"],
    ],
    [],
    "ambiguous_date",
  );
  add(
    "summary-words-in-narration",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Balance"],
      ["", "Opening balance", "", "150.00"],
      ["2025-05-16", "Total Tools", "-10.00", "140.00"],
      ["2025-05-17", "Withdrawal ATM", "-20.00", "120.00"],
    ],
    [
      ["Opening balance", "150", null],
      ["Closing balance", "120", null],
      ["Total Tools", "-10", "2025-05-16"],
      ["Withdrawal ATM", "-20", "2025-05-17"],
    ],
  );
  add(
    "trap-suffix-conflict",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Balance"],
      ["", "Opening balance", "", "100.00"],
      ["2025-05-16", "Purchase", "-10.00 CR", "90.00"],
    ],
    [["Opening balance", "100", null]],
    "dropped_amount",
  );
  add(
    "trap-foreign-only",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount (EUR)", "Balance"],
      ["", "Opening balance", "", "100.00"],
      ["2025-05-16", "Purchase", "-10.00", "90.00"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "trap-header-denomination",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount (USD EUR)", "Balance"],
      ["", "Opening balance", "", "100.00"],
      ["2025-05-16", "Purchase", "-10.00", "90.00"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "boundary-date-evidence",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Balance"],
      ["01-20-2025", "Opening balance", "", "100.00"],
      ["02-03-2025", "Delivery", "-8.00", "92.00"],
    ],
    [
      ["Opening balance", "100", null],
      ["Closing balance", "92", null],
      ["Delivery", "-8", "2025-02-03"],
    ],
  );
  add(
    "marked-pair",
    "xlsx",
    "INR",
    [
      ["Account currency INR"],
      ["Date", "Details", "Debit", "Credit", "Balance"],
      ["", "Opening balance", "", "", "400.00 Cr"],
      ["2025-06-18", "Courier", "30.00 Dr", "", "370.00 Cr"],
    ],
    [
      ["Opening balance", "400", null],
      ["Closing balance", "370", null],
      ["Courier", "-30", "2025-06-18"],
    ],
  );
  add(
    "metadata-fx",
    "csv",
    "SGD",
    [
      ["Account currency SGD"],
      ["Original currency JPY"],
      ["Opening balance: SGD 200.00"],
      ["Date", "Details", "Account amount", "Original amount", "Balance"],
      ["2025-06-18", "Ticket", "-20.00", "-2100", "180.00"],
    ],
    [
      ["Opening balance", "200", null],
      ["Closing balance", "180", null],
      ["Ticket", "-20", "2025-06-18"],
    ],
  );
  add(
    "trap-narrative-currency",
    "pdf",
    "USD",
    [
      ["Account currency USD EUR"],
      ["Period 2025-06-01 to 2025-06-30"],
      ["Opening balance 100.00"],
      ["2025-06-18 Purchase -20.00"],
      ["Closing balance 80.00"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "trap-row-denomination",
    "csv",
    "USD",
    [
      ["Date", "Details", "Amount (EUR)", "Balance (USD)", "Currency"],
      ["", "Opening balance", "", "100.00", "USD"],
      ["2025-06-18", "Purchase", "-10.00", "90.00", "USD"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "trap-swapped-header",
    "pdf",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Debit", "Credit", "Balance"],
      ["", "Opening balance", "", "", "100.00"],
      ["2025-06-18", "Receipt", "", "1.00", "101.00"],
      ["Date", "Details", "Credit", "Debit", "Balance"],
      ["2025-06-19", "Purchase", "", "10.00", ""],
      ["2025-06-20", "Refund", "10.00", "", ""],
      ["", "Closing balance", "", "", "101.00"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "trap-balance-sign",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Balance"],
      ["", "Opening balance", "", "-100.00 CR"],
      ["2025-06-18", "Refund", "10.00", "-90.00 CR"],
    ],
    [],
    "dropped_amount",
  );
  add(
    "trap-token-currency",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Balance"],
      ["", "Opening balance", "", "100.00"],
      ["2025-06-18", "Purchase", "EUR -10.00", "90.00"],
    ],
    [],
    "layout_unresolved",
  );
  add(
    "trap-compact-marker",
    "csv",
    "USD",
    [
      ["Account currency USD"],
      ["Date", "Details", "Amount", "Direction", "Balance"],
      ["", "Opening balance", "", "", "100.00"],
      ["2025-06-18", "Purchase", "10.00CR", "DR", "90.00"],
    ],
    [["Opening balance", "100", null]],
    "dropped_amount",
  );
  return fixtures;
}
