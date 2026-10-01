import { writeXlsx } from "../../src/imports/xlsx-write.js";
import type { BankGolden } from "./bank-round3a-corpus.js";

// Invented exports with literal, independently calculated balances.
export function bankValueCorpus(): BankGolden[] {
  const fixtures: BankGolden[] = [];
  const add = (
    id: string,
    rows: string[][],
    facts: BankGolden["facts"],
    issue?: BankGolden["issue"],
  ) => {
    fixtures.push({
      id,
      fileName: `${id}.csv`,
      currency: "USD",
      bytes: new TextEncoder().encode(rows.map((row) => row.join(",")).join("\n")),
      facts,
      ...(issue ? { issue } : {}),
    });
  };
  const header = [
    "Details",
    "Posting Date",
    "Description",
    "Amount",
    "Type",
    "Balance",
    "Check or Slip #",
  ];
  const rows = [
    ["DEBIT", "09/14/2025", "Maple supplies", "-32.45", "ACH_DEBIT", "467.55", ""],
    ["CHECK", "09/15/2025", "Cedar repair", "-17.55", "CHECK_PAID", "450.00", "81"],
    ["CREDIT", "09/16/2025", "Juniper refund", "80.25", "ACH_CREDIT", "530.25", ""],
    ["DSLIP", "09/17/2025", "Willow deposit", "9.75", "DEPOSIT", "540.00", ""],
  ];
  const facts: BankGolden["facts"] = [
    ["Maple supplies", "-32.45", "2025-09-14"],
    ["Cedar repair", "-17.55", "2025-09-15"],
    ["Juniper refund", "80.25", "2025-09-16"],
    ["Willow deposit", "9.75", "2025-09-17"],
  ];
  for (const reverse of [false, true]) {
    for (const short of [false, true]) {
      const activity = rows.map((row, i) => (short ? [i < 2 ? "Dr" : "Cr", ...row.slice(1)] : row));
      add(
        `alder-${reverse ? "newest" : "oldest"}-${short ? "dr-cr" : "types"}`,
        [
          ["Alder Bank account currency USD"],
          header,
          ["Opening balance", "500.00"],
          ...(reverse ? [...activity].reverse() : activity),
          ["Total debits", "50.00"],
          ["Credits", "90.00"],
          ["Transaction count", "4"],
        ],
        [
          ["Opening balance", "500", null],
          ["Closing balance", "540", null],
          ...(reverse ? [...facts].reverse() : facts),
        ],
      );
    }
  }
  add(
    "alder-no-opening",
    [["Alder Bank USD"], header, ...[...rows].reverse()],
    [["Closing balance", "540", null], ...[...facts].reverse()],
    "balance_mismatch",
  );

  const simpleHeader = ["Date", "Description", "Amount", "Balance"];
  const base = [["Birch Bank USD"], simpleHeader, ["Opening balance", "200.00"]];
  const valid = ["2025-09-14", "Orchard tools", "-20.00", "180.00"];
  const retained: BankGolden["facts"] = [
    ["Opening balance", "200", null],
    ["Orchard tools", "-20", "2025-09-14"],
  ];
  add(
    "excluded-latest",
    [...base, valid, ["2025-09-15", "Unreadable transfer", "", "160.00"]],
    retained,
    "dropped_amount",
  );
  add(
    "excluded-with-explicit-close",
    [
      ...base,
      valid,
      ["2025-09-15", "Unreadable transfer", "", "160.00"],
      ["Closing balance", "160.00"],
    ],
    [retained[0]!, ["Closing balance", "160", null], retained[1]!],
    "dropped_amount",
  );
  add(
    "running-mismatch",
    [...base, valid, ["2025-09-15", "Garden refund", "10.00", "195.00"]],
    [...retained, ["Garden refund", "10", "2025-09-15"]],
    "balance_mismatch",
  );
  add(
    "uncertain-order",
    [
      ...base,
      ["2025-09-16", "Garden refund", "10.00", "185.00"],
      valid,
      ["2025-09-15", "Seed fee", "-5.00", "175.00"],
    ],
    [
      retained[0]!,
      ["Garden refund", "10", "2025-09-16"],
      retained[1]!,
      ["Seed fee", "-5", "2025-09-15"],
    ],
    "balance_mismatch",
  );
  add(
    "same-day-uncertain",
    [["Birch Bank USD"], simpleHeader, valid, ["2025-09-14", "Seed fee", "-5.00", "175.00"]],
    [retained[1]!, ["Seed fee", "-5", "2025-09-14"]],
    "balance_mismatch",
  );
  add(
    "summary-mismatch",
    [...base, valid, ["Total debits", "25.00"]],
    retained,
    "balance_mismatch",
  );
  add(
    "conflicting-close",
    [...base, valid, ["Closing balance", "180.00"], ["Closing balance", "190.00"]],
    retained,
    "balance_mismatch",
  );
  add(
    "direction-conflict",
    [
      ["Alder Bank USD"],
      header,
      ["Opening balance", "500.00"],
      rows[0]!,
      ["CREDIT", "09/15/2025", "Conflicting refund", "-5.00", "ACH_CREDIT", "462.55"],
    ],
    [["Opening balance", "500", null], facts[0]!],
    "dropped_amount",
  );
  add(
    "missing-date-type",
    [
      ["Alder Bank USD"],
      header,
      ["Opening balance", "500.00"],
      rows[0]!,
      ["DEBIT", "", "Missing date fee", "-5.00", "ACH_DEBIT", "462.55"],
    ],
    [["Opening balance", "500", null], facts[0]!],
    "ambiguous_date",
  );
  add(
    "summary-word-description",
    [
      ["Alder Bank USD"],
      header,
      ["Opening balance", "500.00"],
      ["CREDIT", "09/14/2025", "Credits", "5.00", "ACH_CREDIT", "505.00"],
      ["DEBIT", "09/15/2025", "Posting adjustment", "-2.00", "ACH_DEBIT", "503.00"],
    ],
    [
      ["Opening balance", "500", null],
      ["Closing balance", "503", null],
      ["Credits", "5", "2025-09-14"],
      ["Posting adjustment", "-2", "2025-09-15"],
    ],
  );
  add(
    "explicit-sign-conflict",
    [
      ["Alder Bank USD"],
      header,
      ["Opening balance", "500.00"],
      rows[0]!,
      ["DEBIT", "09/15/2025", "Contradictory plus", "+5.00", "ACH_DEBIT", "462.55"],
    ],
    [],
    "layout_unresolved",
  );

  const numericRows = [
    ["Hazel Bank USD"],
    simpleHeader,
    ["Opening balance", "2000"],
    ["2025-09-14", "Bench parts", "-95.09999999999999", "1904.9"],
    ["2025-09-15", "Small refund", "0.29999999999999999", "1905.2"],
    ["2025-09-16", "Workshop rent", "-1234.0699999999999", "671.13"],
  ];
  fixtures.push({
    id: "numeric-xlsx",
    fileName: "numeric-xlsx.xlsx",
    currency: "USD",
    bytes: writeXlsx([
      {
        name: "Activity",
        cells: numericRows.flatMap((row, r) =>
          row.map((value, c) => ({
            row: r + 1,
            col: c + 1,
            value,
            kind: /^-?\d+(?:\.\d+)?$/.test(value) ? ("number" as const) : ("string" as const),
          })),
        ),
      },
    ]),
    facts: [
      ["Opening balance", "2000", null],
      ["Closing balance", "671.13", null],
      ["Bench parts", "-95.1", "2025-09-14"],
      ["Small refund", "0.3", "2025-09-15"],
      ["Workshop rent", "-1234.07", "2025-09-16"],
    ],
  });
  return fixtures;
}
