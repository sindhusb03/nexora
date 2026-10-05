import type { CashFlowClass, ReportClass } from "./statements.js";

/**
 * Canonical chart used by ingestion mapping and the linked-model journals.
 * Posted journals use these codes. Totals and subtotals are not accounts.
 */
export interface CanonicalAccount {
  readonly code: string;
  readonly name: string;
  readonly report: ReportClass;
  readonly cashFlow: CashFlowClass;
  readonly contra: boolean;
}

const ACCOUNTS: readonly CanonicalAccount[] = [
  { code: "cash", name: "Cash", report: "asset", cashFlow: "cash", contra: false },
  {
    code: "accounts_receivable",
    name: "Accounts receivable",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  { code: "inventory", name: "Inventory", report: "asset", cashFlow: "cfo", contra: false },
  {
    code: "prepaid_expenses",
    name: "Prepaid expenses",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "fixed_assets",
    name: "Fixed assets",
    report: "asset",
    cashFlow: "cfi",
    contra: false,
  },
  {
    code: "accumulated_depreciation",
    name: "Accumulated depreciation",
    report: "asset",
    cashFlow: "non_cash",
    contra: true,
  },
  {
    code: "other_assets",
    name: "Other assets",
    report: "asset",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "accounts_payable",
    name: "Accounts payable",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "accrued_expenses",
    name: "Accrued expenses",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "short_term_debt",
    name: "Short-term debt",
    report: "liability",
    cashFlow: "cff",
    contra: false,
  },
  {
    code: "long_term_debt",
    name: "Long-term debt",
    report: "liability",
    cashFlow: "cff",
    contra: false,
  },
  {
    code: "other_liabilities",
    name: "Other liabilities",
    report: "liability",
    cashFlow: "non_cash",
    contra: false,
  },
  { code: "common_stock", name: "Common stock", report: "equity", cashFlow: "cff", contra: false },
  {
    code: "retained_earnings",
    name: "Retained earnings",
    report: "equity",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "distributions",
    name: "Distributions",
    report: "equity",
    cashFlow: "distribution",
    contra: false,
  },
  { code: "other_equity", name: "Other equity", report: "equity", cashFlow: "cff", contra: false },
  { code: "revenue", name: "Revenue", report: "revenue", cashFlow: "cfo", contra: false },
  { code: "other_income", name: "Other income", report: "revenue", cashFlow: "cfo", contra: false },
  { code: "cogs", name: "Cost of goods sold", report: "expense", cashFlow: "cfo", contra: false },
  {
    code: "operating_expenses",
    name: "Operating expenses",
    report: "expense",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "depreciation",
    name: "Depreciation",
    report: "expense",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "interest_expense",
    name: "Interest expense",
    report: "expense",
    cashFlow: "cff",
    contra: false,
  },
  { code: "tax_expense", name: "Tax expense", report: "expense", cashFlow: "cfo", contra: false },
];

const BY_CODE = new Map(ACCOUNTS.map((account) => [account.code, account]));

export function listCanonicalAccounts(): readonly CanonicalAccount[] {
  return ACCOUNTS;
}

export function canonicalAccount(code: string): CanonicalAccount | null {
  return BY_CODE.get(code) ?? null;
}

export function isExpenseAccount(code: string | null): boolean {
  if (!code) return false;
  return BY_CODE.get(code)?.report === "expense";
}

export function isRevenueAccount(code: string | null): boolean {
  if (!code) return false;
  return BY_CODE.get(code)?.report === "revenue";
}
