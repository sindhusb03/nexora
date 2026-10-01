import type {
  Account,
  Exception,
  ExtractedValue,
  Provenance,
  SourceDocument,
} from "@nexora/contracts";

import { buildPdf, buildSimplePdf } from "./simple-pdf";

const JOB = "demo";
const US = "Nazareno Services LLC";
const IN = "Meridian Textiles Pvt Ltd";

export interface DemoPack {
  readonly context: {
    readonly asOf: string;
    readonly basis: string;
    readonly disclaimer: string;
  };
  readonly documents: readonly SourceDocument[];
  readonly values: readonly ExtractedValue[];
  readonly exceptions: readonly Exception[];
  readonly chart: readonly Account[];
}

let cached: DemoPack | null = null;

export function buildDemoPack(): DemoPack {
  cached ??= createDemoPack();
  return cached;
}

function createDemoPack(): DemoPack {
  const meridianPdf = buildPdf([
    ["Meridian Textiles Pvt Ltd", "Balance sheet", "Continued on page 2"],
    [
      "Meridian Textiles Pvt Ltd",
      "Balance sheet as at 31 March 2025",
      "Currency INR",
      "Total assets 12,50,00,000",
      "Total equity and liabilities 12,42,00,000",
    ],
  ]);
  const bankPdf = buildSimplePdf([
    "Nazareno Services LLC",
    "Operating account — December 2025",
    "Currency USD",
    "Ending balance 48,000.00",
  ]);

  const documents: SourceDocument[] = [
    doc("naz_is", "Nazareno_Income_Statement_FY2025.xlsx", xlsx, US, "USD", "US", null, [
      "Income statement",
    ]),
    doc("naz_bs", "Nazareno_Balance_Sheet_FY2025.xlsx", xlsx, US, "USD", "US", null, [
      "Balance sheet",
    ]),
    doc(
      "naz_bank",
      "Nazareno_Operating_Account_Dec2025.pdf",
      "application/pdf",
      US,
      "USD",
      "US",
      1,
      [],
      bankPdf,
    ),
    doc(
      "mer_pl",
      "Meridian_Statement_of_Profit_and_Loss_FY2025.csv",
      "text/csv",
      IN,
      "INR",
      "IN",
      null,
      [],
    ),
    doc(
      "mer_bs",
      "Meridian_Balance_Sheet_FY2025.pdf",
      "application/pdf",
      IN,
      "INR",
      "IN",
      2,
      [],
      meridianPdf,
    ),
    doc("mer_gst", "Meridian_GSTR3B_FY2025.xlsx", xlsx, IN, "INR", "IN", null, ["GSTR-3B"]),
  ];

  const values: ExtractedValue[] = [
    value(
      "assets",
      "mer_bs",
      "Total assets",
      "balance",
      "FY2025",
      "12500000000",
      "INR",
      prov("mer_bs", "Meridian_Balance_Sheet_FY2025.pdf", {
        page: 2,
        rawText: "Total assets 12,50,00,000",
        bbox: { x: 72, y: 656, width: 280, height: 16 },
      }),
    ),
    value(
      "fees",
      "naz_is",
      "Implementation fees",
      "income",
      "FY2025",
      "2400000",
      "USD",
      prov("naz_is", "Nazareno_Income_Statement_FY2025.xlsx", {
        sheet: "Income statement",
        row: 14,
        col: 1,
        rawText: "Implementation fees",
      }),
      grid(12, 14, 1, [
        ["Account", "Amount"],
        ["Service revenue", "158000.00"],
        ["Implementation fees", "24000.00"],
        ["Salaries", "42000.00"],
      ]),
    ),
    value(
      "cash",
      "naz_bs",
      "Ending cash",
      "balance",
      "FY2025",
      "4800000",
      "USD",
      prov("naz_bs", "Nazareno_Balance_Sheet_FY2025.xlsx", {
        sheet: "Balance sheet",
        row: 8,
        col: 2,
        rawText: "48000.00",
      }),
      grid(6, 8, 2, [
        ["Line", "Amount"],
        ["Opening cash", "42000.00"],
        ["Ending cash", "48000.00"],
      ]),
    ),
    value(
      "earnings",
      "naz_bs",
      "Retained earnings",
      "balance",
      "FY2025",
      "8300000",
      "USD",
      prov("naz_bs", "Nazareno_Balance_Sheet_FY2025.xlsx", {
        sheet: "Balance sheet",
        row: 22,
        col: 2,
        rawText: "83000.00",
      }),
      grid(20, 22, 2, [
        ["Line", "Amount"],
        ["Net income", "86000.00"],
        ["Retained earnings", "83000.00"],
      ]),
    ),
    value(
      "salaries",
      "naz_is",
      "Salaries",
      "income",
      "FY2025",
      "-4200000",
      "USD",
      prov("naz_is", "Nazareno_Income_Statement_FY2025.xlsx", {
        sheet: "Income statement",
        row: 15,
        col: 2,
        rawText: "(42000.00)",
      }),
      grid(13, 15, 2, [
        ["Account", "Amount"],
        ["Implementation fees", "24000.00"],
        ["Salaries", "(42000.00)"],
      ]),
    ),
    value(
      "in_revenue",
      "mer_pl",
      "Revenue from operations",
      "income",
      "FY2025",
      "9600000000",
      "INR",
      prov("mer_pl", "Meridian_Statement_of_Profit_and_Loss_FY2025.csv", {
        row: 4,
        col: 2,
        rawText: "Revenue from operations,96000000",
      }),
      grid(2, 4, 2, [
        ["Line", "Amount"],
        ["Revenue from operations", "48000000"],
        ["Revenue from operations", "96000000"],
      ]),
    ),
    value(
      "bank_end",
      "naz_bank",
      "Bank ending balance",
      "bank",
      "Dec 2025",
      "4800000",
      "USD",
      prov("naz_bank", "Nazareno_Operating_Account_Dec2025.pdf", {
        page: 1,
        rawText: "Ending balance 48,000.00",
        bbox: { x: 72, y: 656, width: 240, height: 16 },
      }),
    ),
    value(
      "usd_on_inr",
      "mer_pl",
      "Export sample billed in USD",
      "income",
      "FY2025",
      "150000",
      "USD",
      prov("mer_pl", "Meridian_Statement_of_Profit_and_Loss_FY2025.csv", {
        row: 9,
        col: 2,
        rawText: "Export sample,1500 USD",
      }),
      grid(8, 9, 2, [
        ["Line", "Amount"],
        ["Export sample", "1500 USD"],
      ]),
    ),
    value(
      "wages",
      "mer_pl",
      "Employee benefit expense",
      "income",
      "FY2025",
      "1860",
      "INR",
      prov("mer_pl", "Meridian_Statement_of_Profit_and_Loss_FY2025.csv", {
        row: 12,
        col: 2,
        rawText: "Employee benefit expense,18.60",
      }),
      grid(11, 12, 2, [
        ["Line", "Amount"],
        ["Employee benefit expense", "18.60"],
      ]),
    ),
    value(
      "period",
      "naz_is",
      "Statement period",
      "income",
      null,
      null,
      "USD",
      prov("naz_is", "Nazareno_Income_Statement_FY2025.xlsx", {
        sheet: "Income statement",
        row: 1,
        col: 1,
        rawText: "Income statement",
      }),
      grid(1, 1, 1, [["Income statement", ""]]),
    ),
    value(
      "bank_book",
      "naz_bank",
      "Bank ending balance versus books",
      "bank",
      "Dec 2025",
      "5125000",
      "USD",
      prov("naz_bank", "Nazareno_Operating_Account_Dec2025.pdf", {
        page: 1,
        rawText: "Ending balance 51,250.00",
        bbox: { x: 72, y: 656, width: 240, height: 16 },
      }),
    ),
    value(
      "gst",
      "mer_gst",
      "GST output tax",
      "tax",
      "FY2025",
      "79200000",
      "INR",
      prov("mer_gst", "Meridian_GSTR3B_FY2025.xlsx", {
        sheet: "GSTR-3B",
        row: 6,
        col: 2,
        rawText: "Outward tax 7,92,000",
      }),
      grid(4, 6, 2, [
        ["Line", "Amount"],
        ["Profit and loss tax", "864000.00"],
        ["Outward tax", "792000.00"],
      ]),
    ),
    value(
      "header",
      "naz_is",
      "Amount header",
      "income",
      "FY2025",
      null,
      "USD",
      prov("naz_is", "Nazareno_Income_Statement_FY2025.xlsx", {
        sheet: "Income statement",
        row: 3,
        col: 2,
        rawText: "Amount",
      }),
      grid(3, 3, 2, [["Account", "Amount"]]),
    ),
    value(
      "formula",
      "naz_bs",
      "Retained earnings formula",
      "balance",
      "FY2025",
      "8300000",
      "USD",
      prov("naz_bs", "Nazareno_Balance_Sheet_FY2025.xlsx", {
        sheet: "Balance sheet",
        row: 22,
        col: 2,
        rawText: "83000.00",
      }),
      grid(20, 22, 2, [
        ["Line", "Cached"],
        ["Formula", "91000.00"],
        ["Retained earnings", "83000.00"],
      ]),
    ),
  ];

  const exceptions: Exception[] = [
    check(values, "balance_sheet_equation", "error", "0.9700", "mer_bs", "assets", {
      message: "Assets do not equal liabilities and equity on the Meridian balance sheet.",
      expected: "12420000000",
      actual: "12500000000",
      diff: "80000000",
      currency: "INR",
    }),
    check(values, "unmapped_account", "error", "0.6400", "naz_is", "fees", {
      message: 'Source account "Implementation fees" is not mapped to the chart.',
      expected: null,
      actual: "2400000",
      diff: null,
      currency: "USD",
    }),
    check(values, "cash_rollforward", "warn", "0.9400", "naz_bs", "cash", {
      message: "Ending cash does not roll forward from opening cash and the period movement.",
      expected: "5100000",
      actual: "4800000",
      diff: "-300000",
      currency: "USD",
    }),
    check(values, "retained_earnings_tie", "warn", "0.8800", "naz_bs", "earnings", {
      message: "Net income does not tie to the retained earnings movement.",
      expected: "8600000",
      actual: "8300000",
      diff: "-300000",
      currency: "USD",
    }),
    check(values, "sign_convention", "warn", "0.9600", "naz_is", "salaries", {
      message: "Salaries were extracted as a credit. The chart expects an expense debit.",
      expected: "4200000",
      actual: "-4200000",
      diff: "-8400000",
      currency: "USD",
      mappedAccount: "6100",
    }),
    check(values, "duplicate_extraction", "warn", "0.9900", "mer_pl", "in_revenue", {
      message: "Revenue from operations was extracted twice from the profit and loss.",
      expected: "4800000000",
      actual: "9600000000",
      diff: "4800000000",
      currency: "INR",
    }),
    check(values, "low_confidence_extraction", "warn", "0.4200", "naz_bank", "bank_end", {
      message: "The ending balance on the bank PDF is below the confidence threshold.",
      expected: null,
      actual: "4800000",
      diff: null,
      currency: "USD",
    }),
    check(values, "currency_mismatch", "warn", "0.9300", "mer_pl", "usd_on_inr", {
      message: "A USD amount was found on an INR profit and loss row.",
      expected: null,
      actual: "150000",
      diff: null,
      currency: "USD",
    }),
    check(values, "unit_scale", "warn", "0.9550", "mer_pl", "wages", {
      message: "Employee benefit expense looks stated in lakhs, not rupees.",
      expected: "186000000",
      actual: "1860",
      diff: "-185998140",
      currency: "INR",
    }),
    check(values, "missing_period", "info", "0.6100", "naz_is", "period", {
      message: "The income statement sheet has no period header.",
      expected: null,
      actual: null,
      diff: null,
      currency: "USD",
    }),
    check(values, "bank_to_book", "warn", "0.9050", "naz_bank", "bank_book", {
      message: "The bank statement ending balance does not match book cash.",
      expected: "4800000",
      actual: "5125000",
      diff: "325000",
      currency: "USD",
    }),
    check(values, "tax_tie", "warn", "0.8700", "mer_gst", "gst", {
      message: "GST output tax does not tie to the profit and loss tax line.",
      expected: "86400000",
      actual: "79200000",
      diff: "-7200000",
      currency: "INR",
    }),
    check(values, "header_as_value", "info", "0.9900", "naz_is", "header", {
      message: 'The column header "Amount" was read as a numeric row.',
      expected: null,
      actual: null,
      diff: null,
      currency: "USD",
    }),
    check(values, "formula_cached_mismatch", "warn", "0.7600", "naz_bs", "formula", {
      message: "The retained earnings formula does not match the cached cell value.",
      expected: "9100000",
      actual: "8300000",
      diff: "-800000",
      currency: "USD",
    }),
  ];

  return {
    context: {
      asOf: "2025-12-31",
      basis: "Unposted extraction",
      disclaimer:
        "These figures are proposals from extraction. The Financial Kernel has not posted them.",
    },
    documents,
    values,
    exceptions,
    chart: [
      account("1000", "Cash", US, "USD"),
      account("1200", "Accounts receivable", US, "USD"),
      account("2000", "Accounts payable", US, "USD"),
      account("3000", "Retained earnings", US, "USD"),
      account("4000", "Service revenue", US, "USD"),
      account("6100", "Salaries and wages", US, "USD"),
      account("6800", "Owner travel", US, "USD"),
      account("1100", "Cash and cash equivalents", IN, "INR"),
      account("1300", "Trade receivables", IN, "INR"),
      account("1500", "GST input credit", IN, "INR"),
      account("2100", "Trade payables", IN, "INR"),
      account("2200", "GST payable", IN, "INR"),
      account("3100", "Revenue from operations", IN, "INR"),
      account("4100", "Cost of materials", IN, "INR"),
      account("4200", "Employee benefit expense", IN, "INR"),
    ],
  };
}

const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;

function doc(
  id: string,
  fileName: string,
  mediaType: SourceDocument["mediaType"],
  entityName: string,
  currency: string,
  regionHint: SourceDocument["regionHint"],
  pageCount: number | null,
  sheetNames: string[],
  pdfBase64: string | null = null,
): SourceDocument {
  return {
    id,
    jobId: JOB,
    fileName,
    mediaType,
    pageCount,
    sheetNames,
    regionHint,
    currency,
    entityName,
    pdfBase64,
  };
}

function account(code: string, name: string, entityName: string, currency: string): Account {
  return { code, name, entityName, currency };
}

function prov(
  documentId: string,
  fileName: string,
  source: {
    page?: number;
    sheet?: string;
    row?: number;
    col?: number;
    bbox?: Provenance["bbox"];
    rawText: string;
  },
): Provenance {
  return {
    documentId,
    fileName,
    page: source.page ?? null,
    sheet: source.sheet ?? null,
    row: source.row ?? null,
    col: source.col ?? null,
    bbox: source.bbox ?? null,
    rawText: source.rawText,
  };
}

function grid(
  originRow: number,
  highlightRow: number,
  highlightCol: number,
  cells: readonly (readonly [string, string])[],
): ExtractedValue["sheetWindow"] {
  return {
    originRow,
    originCol: 1,
    highlightRow,
    highlightCol,
    cells: cells.map((row) => [row[0], row[1]]),
  };
}

function value(
  id: string,
  documentId: string,
  label: string,
  statement: ExtractedValue["statement"],
  periodLabel: string | null,
  amountMinor: string | null,
  currency: string,
  provenance: Provenance,
  sheetWindow: ExtractedValue["sheetWindow"] = null,
): ExtractedValue {
  return {
    id,
    jobId: JOB,
    documentId,
    label,
    statement,
    periodLabel,
    amountMinor,
    currency,
    provenance,
    sheetWindow,
  };
}

function check(
  values: readonly ExtractedValue[],
  type: Exception["type"],
  severity: Exception["severity"],
  confidence: string,
  documentId: string,
  valueId: string,
  amounts: Exception["values"] & { message: string; mappedAccount?: string | null },
): Exception {
  const source = values.find((item) => item.id === valueId);
  if (!source) throw new Error(`Missing demo value ${valueId}`);
  return {
    id: type,
    jobId: JOB,
    documentId,
    valueIds: [valueId],
    type,
    severity,
    message: amounts.message,
    values: {
      expected: amounts.expected,
      actual: amounts.actual,
      diff: amounts.diff,
      currency: amounts.currency,
    },
    confidence,
    provenance: [source.provenance],
    status: "open",
    mappedAccount: amounts.mappedAccount ?? null,
    resolution: null,
    auditTrail: [],
  };
}
