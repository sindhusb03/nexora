import { encodeGrid } from "./adversarial-corpus.js";
import { renderTextPdf } from "../../src/imports/text-pdf.js";

type Fact = readonly [string, string, string, string, string];
type Layout = {
  id: string;
  format: "csv" | "xlsx" | "pdf";
  rows: string[][];
  facts: Fact[];
  held?: boolean;
};
const bs = (label: string, amount: string, end = "2024-12-31"): Fact => [
  label,
  amount,
  end,
  "balance_sheet",
  "line",
];
const pl = (label: string, amount: string, end = "2024-12-31"): Fact => [
  label,
  amount,
  end,
  "income_statement",
  "line",
];
const assets = (headers: string[]): string[][] => [
  ["Bilan actif au 31 December 2024"],
  ["Particulars", ...headers],
  ["Equipment", "1500.25", "200.10", "1300.15", "1200.05"],
  ["Total actif", "1500.25", "200.10", "1300.15", "1200.05"],
];
const tally = (balance: boolean, mismatch = false): string[][] => [
  [
    balance
      ? "Balance Sheet as at 31 December 2024"
      : "Profit and Loss year ended 31 December 2024",
  ],
  [
    balance ? "Liabilities" : "Particulars",
    "Amount",
    "Amount",
    balance ? "Assets" : "Particulars",
    "Amount",
    "Amount",
  ],
  [
    balance ? "Liabilities" : "Operating expenses",
    "",
    balance ? "500.50" : "200.25",
    balance ? "Cash" : "Sales",
    "",
    "500.50",
  ],
  [balance ? "Equity" : "", balance ? "300.25" : "", "", "", "", ""],
  [balance ? "Borrowings" : "Rent expense", "100.10", "", balance ? "" : "", "", ""],
  [balance ? "Accounts payable" : "Salary expense", "100.15", "", "", "", ""],
  [balance ? "" : "Net Profit", "", balance ? "" : "300.25", "", "", ""],
  ["Total", "", "500.50", "Total", "", mismatch ? "500.51" : "500.50"],
];
export function statementBlockCorpus() {
  const layouts: Layout[] = [
    {
      id: "fr-actif",
      format: "xlsx",
      rows: assets([
        "Brut",
        "Amortissements et depreciations",
        "Net 31 December 2024",
        "Net 31 December 2023",
      ]),
      facts: [bs("Equipment", "1300.15"), bs("Equipment", "1200.05", "2023-12-31")],
    },
    {
      id: "fr-passif",
      format: "csv",
      rows: [
        ["Bilan passif au 31 December 2024"],
        ["Particulars", "Net 31 December 2024"],
        ["Equity", "1300.15"],
        ["Total passif", "1300.15"],
      ],
      facts: [bs("Equity", "1300.15")],
    },
    ...(["english", "spanish", "german"] as const).map((id, i): Layout => ({
      id,
      format: (["pdf", "csv", "xlsx"] as const)[i]!,
      rows: assets(
        i === 0
          ? [
              "Gross",
              "Accumulated depreciation",
              "Net book value 31 December 2024",
              "Net book value 31 December 2023",
            ]
          : i === 1
            ? ["Bruto", "Amortización", "Neto 31 December 2024", "Neto 31 December 2023"]
            : [
                "Anschaffungskosten",
                "Abschreibungen",
                "Buchwert 31 December 2024",
                "Buchwert 31 December 2023",
              ],
      ),
      facts: [bs("Equipment", "1300.15"), bs("Equipment", "1200.05", "2023-12-31")],
    })),
    {
      id: "tally-pl",
      format: "csv",
      rows: tally(false),
      facts: [pl("Rent expense", "100.1"), pl("Salary expense", "100.15"), pl("Sales", "500.5")],
    },
    {
      id: "tally-bs",
      format: "xlsx",
      rows: tally(true),
      facts: [
        bs("Equity", "300.25"),
        bs("Borrowings", "100.1"),
        bs("Accounts payable", "100.15"),
        bs("Cash", "500.5"),
      ],
    },
    {
      id: "tally-pdf",
      format: "pdf",
      rows: tally(false),
      facts: [pl("Rent expense", "100.1"), pl("Salary expense", "100.15"), pl("Sales", "500.5")],
    },
    {
      id: "stacked",
      format: "xlsx",
      rows: [
        ["Income Statement year ended 31 December 2024"],
        ["Particulars", "31 December 2024"],
        ["Sales", "900.01"],
        [],
        ["Balance Sheet as at 31 March 2025"],
        ["Particulars", "31 March 2025"],
        ["Cash", "400.05"],
      ],
      facts: [pl("Sales", "900.01"), bs("Cash", "400.05", "2025-03-31")],
    },
    {
      id: "parallel-years",
      format: "csv",
      rows: [
        [
          "Income Statement year ended 31 December 2024",
          "",
          "Income Statement year ended 31 December 2023",
        ],
        ["Particulars", "Amount", "Particulars", "Amount"],
        ["Sales", "900.01", "Sales", "800.02"],
      ],
      facts: [pl("Sales", "900.01"), pl("Sales", "800.02", "2023-12-31")],
    },
    {
      id: "gross-mismatch",
      format: "csv",
      rows: assets(["Brut", "Amort. / Prov.", "Net 31 December 2024", "Net 31 December 2023"]).map(
        (r, i) => (i === 2 ? [r[0]!, "1500.26", ...r.slice(2)] : r),
      ),
      facts: [],
      held: true,
    },
    { id: "unequal-sides", format: "xlsx", rows: tally(false, true), facts: [], held: true },
    {
      id: "untitled-block",
      format: "csv",
      rows: [
        ["Particulars", "Amount", "Particulars", "Amount"],
        ["Rent expense", "100.01", "Sales", "200.02"],
      ],
      facts: [],
      held: true,
    },
    {
      id: "missing-amort-header",
      format: "pdf",
      rows: assets(["Brut", "", "Net 31 December 2024", "Net 31 December 2023"]),
      facts: [],
      held: true,
    },
    {
      id: "fr-net-n",
      format: "csv",
      rows: assets(["Brut", "Amort. / Prov.", "Net N", "Net N-1"]),
      facts: [bs("Equipment", "1300.15"), bs("Equipment", "1200.05", "2023-12-31")],
    },
    {
      id: "cost-nbv",
      format: "xlsx",
      rows: assets(["Cost", "Depreciation", "NBV 31 December 2024", "NBV 31 December 2023"]),
      facts: [bs("Equipment", "1300.15"), bs("Equipment", "1200.05", "2023-12-31")],
    },
    {
      id: "untitled-stacked",
      format: "xlsx",
      rows: [
        ["Income Statement year ended 31 December 2024"],
        ["Account", "31 December 2024"],
        ["Sales", "900.01"],
        [],
        ["Account", "31 March 2025"],
        ["Cash", "400.05"],
      ],
      facts: [],
      held: true,
    },
    {
      id: "parallel-pdf",
      format: "pdf",
      rows: [
        [
          "Income Statement year ended 31 December 2024",
          "",
          "",
          "Income Statement year ended 31 December 2023",
        ],
        ["Particulars", "Amount", "", "Particulars", "Amount"],
        ["Sales", "900.01", "", "Sales", "800.02"],
      ],
      facts: [pl("Sales", "900.01"), pl("Sales", "800.02", "2023-12-31")],
    },
    {
      id: "stacked-pdf",
      format: "pdf",
      rows: [
        ["Income Statement year ended 31 December 2024"],
        ["Account", "31 December 2024"],
        ["Sales", "900.01"],
        [],
        ["Balance Sheet as at 31 March 2025"],
        ["Account", "31 March 2025"],
        ["Cash", "400.05"],
      ],
      facts: [pl("Sales", "900.01"), bs("Cash", "400.05", "2025-03-31")],
    },
    {
      id: "wrong-side",
      format: "csv",
      rows: tally(false).map((r) => (r[0] === "Rent expense" ? ["Sales", ...r.slice(1)] : r)),
      facts: [],
      held: true,
    },
  ];
  return layouts.map((layout) => ({
    ...layout,
    fileName: `${layout.id}.${layout.format}`,
    bytes:
      layout.format === "pdf"
        ? renderTextPdf([
            layout.rows.map((row) => ({
              items: row.map((text, c) => ({
                x: [28, 155, 240, 360, 480, 550][c]!,
                text: text
                  .replace(/Net book value/g, "NBV")
                  .replace(/31 December 2024/g, "31/12/2024")
                  .replace(/31 December 2023/g, "31/12/2023"),
              })),
            })),
          ])
        : encodeGrid(layout.rows, layout.format, "Report"),
  }));
}
