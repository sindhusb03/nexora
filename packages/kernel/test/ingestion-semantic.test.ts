import { describe, expect, it } from "vitest";

import {
  buildLinkedModel,
  mapLineLabel,
  mappingIsAutoAcceptable,
  type IngestionAmount,
  type IngestionCheckInput,
} from "../src/index.js";

const LABELS: readonly {
  readonly label: string;
  readonly code: string;
  readonly contra: boolean;
  readonly auto: boolean;
}[] = [
  { label: "Cash", code: "cash", contra: false, auto: true },
  { label: "Sales Accounts", code: "revenue", contra: false, auto: true },
  { label: "Revenue from operations", code: "revenue", contra: false, auto: true },
  { label: "Trade Receivables", code: "accounts_receivable", contra: false, auto: true },
  { label: "Trade Payables", code: "accounts_payable", contra: false, auto: true },
  { label: "Cost of materials consumed", code: "cogs", contra: false, auto: true },
  { label: "Employee benefits expense", code: "operating_expenses", contra: false, auto: true },
  { label: "Finance costs", code: "interest_expense", contra: false, auto: true },
  { label: "Depreciation and amortisation", code: "depreciation", contra: false, auto: true },
  { label: "Share capital", code: "common_stock", contra: false, auto: true },
  { label: "Reserves and Surplus", code: "retained_earnings", contra: false, auto: true },
  { label: "Borrowings", code: "long_term_debt", contra: false, auto: true },
  { label: "Profit and Loss A/c", code: "retained_earnings", contra: false, auto: true },
  { label: "Checking", code: "cash", contra: false, auto: true },
  { label: "Purchases", code: "cogs", contra: false, auto: true },
  { label: "Inventories", code: "inventory", contra: false, auto: true },
  { label: "Sundry Debtors", code: "accounts_receivable", contra: false, auto: true },
  { label: "Sundry Creditors", code: "accounts_payable", contra: false, auto: true },
  { label: "Short-term borrowings", code: "short_term_debt", contra: false, auto: true },
  { label: "Current tax", code: "tax_expense", contra: false, auto: true },
  { label: "Tangible assets", code: "fixed_assets", contra: false, auto: true },
  { label: "Cash and cash equivalents", code: "cash", contra: false, auto: true },
  { label: "Other expenses", code: "operating_expenses", contra: false, auto: true },
  { label: "Equity share capital", code: "common_stock", contra: false, auto: true },
  { label: "Net Income", code: "net_income", contra: false, auto: true },
  {
    label: "Less: Accumulated Depreciation",
    code: "accumulated_depreciation",
    contra: true,
    auto: false,
  },
  { label: "Cost of Sales", code: "cogs", contra: false, auto: true },
  { label: "Cost of revenue", code: "cogs", contra: false, auto: false },
  { label: "Profit before tax", code: "other_income", contra: false, auto: false },
  { label: "Interest income", code: "other_income", contra: false, auto: false },
  { label: "Deferred revenue", code: "other_liabilities", contra: false, auto: false },
  { label: "Unearned revenue", code: "other_liabilities", contra: false, auto: false },
  { label: "Sales returns", code: "revenue", contra: true, auto: false },
  { label: "Sales discounts", code: "revenue", contra: true, auto: false },
  { label: "Provision for doubtful debts", code: "accounts_receivable", contra: true, auto: false },
  {
    label: "Allowance for doubtful accounts",
    code: "accounts_receivable",
    contra: true,
    auto: false,
  },
  { label: "Cash credit", code: "short_term_debt", contra: false, auto: false },
  { label: "Bank overdraft", code: "short_term_debt", contra: false, auto: false },
  { label: "CC limit", code: "short_term_debt", contra: false, auto: false },
  { label: "Interest on borrowings", code: "interest_expense", contra: false, auto: false },
  { label: "Revenue reserve", code: "retained_earnings", contra: false, auto: false },
  { label: "Interest received", code: "other_income", contra: false, auto: false },
  { label: "Earnings before tax", code: "other_income", contra: false, auto: false },
];

const ADVERSARIAL: readonly {
  readonly label: string;
  readonly code: string;
  readonly contra: boolean;
}[] = [
  { label: "Less: Allowance for obsolete inventory", code: "inventory", contra: true },
  { label: "Output GST on sales", code: "other_liabilities", contra: false },
  { label: "Cash flow hedge reserve", code: "other_equity", contra: false },
  { label: "Revenue received in advance", code: "other_liabilities", contra: false },
  { label: "Notes Payable", code: "short_term_debt", contra: false },
  { label: "Provision for inventory obsolescence", code: "inventory", contra: true },
  { label: "Accumulated amortisation", code: "accumulated_depreciation", contra: true },
  { label: "Impairment of receivables", code: "accounts_receivable", contra: true },
  { label: "Less: impairment of plant", code: "fixed_assets", contra: true },
  { label: "VAT payable", code: "other_liabilities", contra: false },
  { label: "Input tax credit", code: "other_assets", contra: false },
  { label: "TDS deducted", code: "other_liabilities", contra: false },
  { label: "Withholding tax payable", code: "other_liabilities", contra: false },
  { label: "Sales tax collected", code: "other_liabilities", contra: false },
  { label: "Revaluation reserve", code: "other_equity", contra: false },
  { label: "Foreign currency translation reserve", code: "other_equity", contra: false },
  { label: "Capital redemption reserve", code: "other_equity", contra: false },
  { label: "Contract liabilities", code: "other_liabilities", contra: false },
  { label: "Bills payable", code: "short_term_debt", contra: false },
  { label: "Debentures", code: "short_term_debt", contra: false },
  { label: "Loan from directors", code: "short_term_debt", contra: false },
  { label: "Bank overdraft facility", code: "short_term_debt", contra: false },
  { label: "Allowance for doubtful inventory", code: "inventory", contra: true },
  { label: "Less: closing stock", code: "inventory", contra: true },
  { label: "Output tax on turnover", code: "other_liabilities", contra: false },
];

describe("semantic mapping guard", () => {
  it("caps class and sign changes and keeps chart synonyms auto-acceptable", () => {
    expect(LABELS.length).toBeGreaterThanOrEqual(40);
    for (const row of LABELS) {
      const hit = mapLineLabel(row.label);
      expect(hit, row.label).toMatchObject({ accountCode: row.code, contra: row.contra });
      expect(mappingIsAutoAcceptable(hit?.confidence ?? "0"), row.label).toBe(row.auto);
    }
  });

  it("sends modifier and class-flip labels to review", () => {
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(25);
    for (const row of ADVERSARIAL) {
      const hit = mapLineLabel(row.label);
      expect(hit, row.label).toMatchObject({ accountCode: row.code, contra: row.contra });
      expect(mappingIsAutoAcceptable(hit?.confidence ?? "0"), row.label).toBe(false);
    }
    expect(mappingIsAutoAcceptable(mapLineLabel("Cost of sales")?.confidence ?? "0")).toBe(true);
    expect(mappingIsAutoAcceptable(mapLineLabel("Cost of goods sold")?.confidence ?? "0")).toBe(
      true,
    );
    expect(mappingIsAutoAcceptable(mapLineLabel("Net revenue")?.confidence ?? "0")).toBe(false);
  });

  it("does not auto-accept qualifiers that change the line", () => {
    const rows: readonly { label: string; code: string | null }[] = [
      { label: "Borrowings, current", code: "short_term_debt" },
      { label: "Total non-current liabilities", code: null },
      { label: "Sales (units)", code: "revenue" },
      { label: "Bank [overdraft]", code: "short_term_debt" },
      { label: "Revenue [deferred]", code: "other_liabilities" },
      { label: "Net revenue", code: "revenue" },
    ];
    for (const row of rows) {
      const hit = mapLineLabel(row.label);
      expect(hit?.accountCode ?? null, row.label).toBe(row.code);
      expect(mappingIsAutoAcceptable(hit?.confidence ?? "0"), row.label).toBe(false);
    }
  });
});

function amount(
  periodEnd: string,
  periodStart: string,
  code: string,
  minor: string,
  statement: IngestionAmount["statement"] = "balance_sheet",
): IngestionAmount {
  return {
    valueId: `${code}-${periodEnd}-${statement}`,
    documentId: "doc",
    statement,
    role: "line",
    accountCode: code,
    label: code,
    periodEnd,
    periodStart,
    spanMonths: 12,
    currency: "USD",
    scale: "units",
    minor,
    contra: false,
    balanceKind: statement === "balance_sheet" ? "closing" : "movement",
    order: 1,
  };
}

function packageFor(
  periods: readonly {
    end: string;
    start: string;
    cash: string;
    payable: string;
    earnings: string;
  }[],
  income: readonly IngestionAmount[],
  posted?: IngestionCheckInput["postedBalances"],
): IngestionCheckInput {
  const amounts = periods.flatMap((period) => [
    amount(period.end, period.start, "cash", period.cash),
    amount(period.end, period.start, "accounts_payable", period.payable),
    amount(period.end, period.start, "retained_earnings", period.earnings),
  ]);
  return {
    currency: "USD",
    toleranceMinor: "0",
    amounts: [...amounts, ...income],
    banks: [],
    documents: [],
    coverage: null,
    mandatoryCodes: [],
    ...(posted ? { postedBalances: posted } : {}),
  };
}

describe("linked model periods", () => {
  const prior = {
    end: "2024-12-31",
    start: "2024-01-01",
    cash: "1500",
    payable: "200",
    earnings: "1300",
  };
  const next = {
    end: "2025-12-31",
    start: "2025-01-01",
    cash: "1700",
    payable: "200",
    earnings: "1500",
  };
  const income = [
    amount("2025-12-31", "2025-01-01", "revenue", "400", "income_statement"),
    amount("2025-12-31", "2025-01-01", "operating_expenses", "200", "income_statement"),
  ];

  it("posts only the new period when the comparative column is already on the ledger", () => {
    const result = buildLinkedModel(
      packageFor([prior, next], income, {
        "2024-12-31": { cash: "1500", accounts_payable: "200", retained_earnings: "1300" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.journals.map((journal) => journal.kind)).toEqual(["movement"]);
    expect(result.model.journals[0]?.periodEnd).toBe("2025-12-31");
    const cash = result.model.journals[0]?.lines.find((line) => line.accountCode === "cash");
    expect(cash).toMatchObject({ debitMinor: "200", creditMinor: "0" });
  });

  it("refuses a balance sheet that would double a posted period", () => {
    const result = buildLinkedModel(
      packageFor([prior, next], income, {
        "2024-12-31": { cash: "750", accounts_payable: "100", retained_earnings: "650" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("double");
  });

  it("returns no journals when every period is already posted", () => {
    const result = buildLinkedModel(
      packageFor([prior, next], income, {
        "2024-12-31": { cash: "1500", accounts_payable: "200", retained_earnings: "1300" },
        "2025-12-31": { cash: "1700", accounts_payable: "200", retained_earnings: "1500" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.journals).toEqual([]);
  });
});
