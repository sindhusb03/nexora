import { encodeGrid } from "./adversarial-corpus.js";
import { renderTextPdf } from "../../src/imports/text-pdf.js";
import type { BankGolden } from "./bank-round3a-corpus.js";

/** Invented layouts; golden facts are literal and independent of extraction. */
export function bankLayoutCorpus(): BankGolden[] {
  const fixtures: BankGolden[] = [];
  const facts: BankGolden["facts"] = [
    ["Opening balance", "1000", null],
    ["Closing balance", "987.75", null],
    ["Stationery", "-15.5", "2025-03-04"],
    ["Refund", "3.25", "2025-03-05"],
  ];
  const add = (
    id: string,
    format: "csv" | "xlsx" | "pdf",
    rows: string[][],
    expected = facts,
    issue?: BankGolden["issue"],
    currency = "EUR",
  ) => {
    const fixture: BankGolden = {
      id,
      fileName: `${id}.${format}`,
      currency,
      bytes: encodeGrid(rows, format, "Activity"),
      facts: expected,
      ...(issue ? { issue } : {}),
    };
    fixtures.push(fixture);
    return fixture;
  };
  const localized = [
    [
      "german",
      "Buchungstag",
      "Verwendungszweck",
      "Soll",
      "Haben",
      "Saldo",
      "Anfangssaldo",
      "Endsaldo",
    ],
    [
      "french",
      "Date opération",
      "Libellé",
      "Débit",
      "Crédit",
      "Solde",
      "Solde précédent",
      "Solde final",
    ],
    ["spanish", "Fecha", "Concepto", "Cargo", "Abono", "Saldo", "Saldo anterior", "Saldo final"],
    [
      "portuguese",
      "Data",
      "Descrição",
      "Débito",
      "Crédito",
      "Saldo",
      "Saldo inicial",
      "Saldo final",
    ],
    [
      "italian",
      "Data contabile",
      "Descrizione",
      "Addebiti",
      "Accrediti",
      "Saldo",
      "Saldo iniziale",
      "Saldo finale",
    ],
    ["dutch", "Boekdatum", "Omschrijving", "Af", "Bij", "Saldo", "Beginsaldo", "Eindsaldo"],
  ];
  localized.forEach(([id, date, memo, debit, credit, balance, opening, closing], i) =>
    add(id!, i % 2 ? "xlsx" : "csv", [
      ["Account currency EUR"],
      [date!, memo!, debit!, credit!, balance!],
      ["", opening!, "", "", "1000,00"],
      ["2025-03-04", "Stationery", "15,50", "", "984,50"],
      ["2025-03-05", "Refund", "", "3,25", "987,75"],
      ["", closing!, "", "", "987,75"],
    ]),
  );
  for (const [id, date, memo, debit, credit, balance] of [
    ["kanji", "取引日", "摘要", "お支払金額", "お預り金額", "残高"],
    ["fullwidth", "日付", "内容", "出金", "入金", "差引残高"],
    ["era-rule", "年月日", "取引内容", "支払金額", "預入金額", "ご預金残高"],
  ]) {
    add(
      id!,
      "csv",
      [
        [
          "Account currency JPY",
          ...(id === "era-rule" ? ["Era rule: R = Reiwa; year = 2018 + era year"] : []),
        ],
        [date!, memo!, debit!, credit!, balance!],
        ["", "前月繰越", "", "", "￥１０００"],
        [
          id === "era-rule" ? "R7.3.4" : "２０２５年３月４日",
          "Stationery",
          "￥１５",
          "",
          "￥９８５",
        ],
        [id === "era-rule" ? "R7.3.5" : "2025/03/05", "Refund", "", "￥３", "￥９８８"],
        ["", "次月繰越", "", "", "￥９８８"],
      ],
      [
        ["Opening balance", "1000", null],
        ["Closing balance", "988", null],
        ["Stationery", "-15", "2025-03-04"],
        ["Refund", "3", "2025-03-05"],
      ],
      undefined,
      "JPY",
    );
  }
  const base = [
    ["Account currency EUR"],
    ["Date", "Description", "Debit", "Credit", "Balance"],
    ["", "B/F", "", "", "1000.00"],
    ["2025-03-04", "Stationery", "15.50", "", "984.50"],
    ["2025-03-05", "Refund", "", "3.25", "987.75"],
    ["", "Carried forward", "", "", "987.75"],
  ];
  for (const delimiter of [",", ";", "\t"]) {
    const rows = base.map((r) => [...r]);
    if (delimiter === "\t") rows[1]![1] = "Memo";
    rows[3]![1] = "Memo\tcomma, semi;\nsecond line";
    const fixture = add(
      `quoted-${delimiter === "," ? "comma" : delimiter === ";" ? "semicolon" : "tab"}`,
      "csv",
      rows,
      facts.map((f) => (f[0] === "Stationery" ? [rows[3]![1]!, f[1], f[2]] : f)),
    );
    fixture.bytes = new TextEncoder().encode(
      rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(delimiter)).join("\r\n"),
    );
  }
  add("headerless-balance", "csv", [
    ["Account currency EUR"],
    ["Opening Balance", "1000.00"],
    ["2025-03-04", "Stationery", "15.50", "984.50"],
    ["2025-03-05", "Refund", "3.25", "987.75"],
    ["Closing Balance", "987.75"],
  ]);
  add("headerless-paired", "xlsx", [
    ["Account currency EUR"],
    ["Opening Balance", "1000.00"],
    ["2025-03-04", "Stationery", "15.50", "", "984.50"],
    ["2025-03-05", "Refund", "", "3.25", "987.75"],
    ["Closing Balance", "987.75"],
  ]);
  add("headerless-reordered", "csv", [
    ["Account currency EUR"],
    ["Opening Balance", "1000.00"],
    ["Stationery", "984.50", "2025-03-04", "15.50"],
    ["Refund", "987.75", "2025-03-05", "3.25"],
    ["Closing Balance", "987.75"],
  ]);
  add("headerless-direction", "csv", [
    ["Account currency EUR"],
    ["Opening Balance", "1000.00"],
    ["2025-03-04", "Stationery", "15.50", "Dr"],
    ["2025-03-05", "Refund", "3.25", "Cr"],
    ["Closing Balance", "987.75"],
  ]);
  add(
    "headerless-broken",
    "csv",
    [
      ["Account currency EUR"],
      ["Opening Balance", "1000.00"],
      ["2025-03-04", "Stationery", "15.50", "984.50"],
      ["2025-03-05", "Refund", "3.25", "999.75"],
      ["Closing Balance", "999.75"],
    ],
    [],
    "layout_unresolved",
  );
  const noFirstDate = base.map((r) => [...r]);
  noFirstDate.splice(1, 1);
  noFirstDate[2]![0] = "";
  add("headerless-dateless-first", "csv", noFirstDate, [], "layout_unresolved");
  add(
    "unsigned-no-balance",
    "csv",
    [
      ["2025-03-04", "Stationery", "15.50"],
      ["2025-03-05", "Refund", "3.25"],
    ],
    [],
    "layout_unresolved",
  );
  const carry = base.map((r) => [...r]);
  carry[4]![0] = "";
  const sameDay = facts.map((f) =>
    f[0] === "Refund" ? ([f[0], f[1], "2025-03-04"] as BankGolden["facts"][number]) : f,
  );
  add("grouped-date", "xlsx", carry, sameDay);
  const first = base.map((r) => [...r]);
  first[3]![0] = "";
  add("dateless-first", "csv", first, [], "ambiguous_date");
  const bad = carry.map((r) => [...r]);
  bad[4]![4] = "988.75";
  add("carry-balance-mismatch", "csv", bad, [], "balance_mismatch");
  const ragged = base.map((r) => [...r]);
  ragged[3]!.splice(1, 0, "rogue");
  add("ragged-row", "csv", ragged, [], "layout_unresolved");
  add(
    "era-without-rule",
    "csv",
    [
      ["Account currency JPY"],
      ["Date", "Description", "Amount", "Balance"],
      ["", "Opening Balance", "", "1000"],
      ["R7.3.4", "Stationery", "15 Dr", "985"],
    ],
    [],
    "ambiguous_date",
    "JPY",
  );
  const pdfRows = (rows: string[][]) =>
    rows.map((row) => ({
      items: row.map((text, c) => ({ text, x: [28, 145, 325, 410, 505][c]! })),
    }));
  const split = [
    ["Value", "Description", "Withdrawal", "Deposit", "Balance"],
    ["Date", "", "Amount", "Amount", ""],
  ];
  const pdf = add("split-repeated-legend", "pdf", [], facts);
  pdf.bytes = renderTextPdf([
    pdfRows([
      ["Account currency EUR"],
      ...split,
      base[2]!,
      ["Dr = Debit, Cr = Credit; Txn types: 1 transfer, 2 fee"],
      base[3]!,
      ["* denotes 3 pending entries"],
    ]),
    pdfRows([...split, base[4]!, base[5]!]),
  ]);
  const pageTrap = add("page-date-reset", "pdf", [], [], "ambiguous_date");
  pageTrap.bytes = renderTextPdf([
    pdfRows([base[0]!, base[1]!, base[2]!, base[3]!]),
    pdfRows([base[1]!, carry[4]!, base[5]!]),
  ]);
  const legendTrap = add("legend-numeric-table", "pdf", [], facts);
  legendTrap.bytes = renderTextPdf([
    pdfRows([
      base[0]!,
      base[1]!,
      base[2]!,
      base[3]!,
      ["", "Txn types: 1 transfer, 2 fee", "99.00", "", "885.50"],
      base[4]!,
      base[5]!,
    ]),
  ]);
  const pdfGrouped = add("pdf-grouped-date", "pdf", [], sameDay);
  pdfGrouped.bytes = renderTextPdf([pdfRows(carry)]);
  add(
    "declared-date-grouping",
    "csv",
    [
      ["Account currency EUR; transactions grouped by date"],
      ["Date", "Description", "Amount"],
      ["", "Opening Balance", "1000.00"],
      ["2025-03-04", "Stationery", "15.50 Dr"],
      ["", "Refund", "3.25 Cr"],
      ["", "Closing Balance", "987.75"],
    ],
    sameDay,
  );
  const shifted = add("page-column-reanchor", "pdf", [], facts);
  shifted.bytes = renderTextPdf([
    pdfRows([base[0]!, base[1]!, base[2]!, base[3]!]),
    pdfRows([base[1]!, base[4]!, base[5]!]).map((row) => ({
      items: row.items.map((item) => ({ ...item, x: item.x + 55 })),
    })),
  ]);
  const displaced = add("unanchored-pdf-row", "pdf", [], [], "layout_unresolved");
  displaced.bytes = renderTextPdf([
    [
      ...pdfRows([base[0]!, base[1]!, base[2]!, base[3]!]),
      ...pdfRows([base[4]!]).map((row) => ({
        items: row.items.map((item) => ({ ...item, x: item.x + 70 })),
      })),
    ],
  ]);
  return fixtures;
}
