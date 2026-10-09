import { KernelError } from "./errors.js";
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
  {
    code: "asset_sale_receivable",
    name: "Asset-sale receivable",
    report: "asset",
    cashFlow: "cfi",
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
  {
    code: "indirect_tax_payable",
    name: "Indirect tax payable",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "indirect_tax_receivable",
    name: "Indirect tax receivable",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "withholding_tax_payable",
    name: "Withholding tax payable",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "withholding_tax_receivable",
    name: "Withholding tax receivable",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "income_tax_payable",
    name: "Income tax payable",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "income_tax_receivable",
    name: "Income tax receivable",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "deferred_tax_asset",
    name: "Deferred tax asset",
    report: "asset",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "deferred_tax_liability",
    name: "Deferred tax liability",
    report: "liability",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "deferred_revenue",
    name: "Deferred revenue",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "contract_assets",
    name: "Contract assets",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  { code: "provisions", name: "Provisions", report: "liability", cashFlow: "cfo", contra: false },
  {
    code: "payroll_liabilities",
    name: "Payroll liabilities",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "payroll_tax_payable",
    name: "Payroll tax payable",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "capex_payables",
    name: "Capex payables",
    report: "liability",
    cashFlow: "cfi",
    contra: false,
  },
  {
    code: "capital_advances",
    name: "Capital advances",
    report: "asset",
    cashFlow: "cfi",
    contra: false,
  },
  {
    code: "security_deposits_paid",
    name: "Security deposits paid",
    report: "asset",
    cashFlow: "cfi",
    contra: false,
  },
  {
    code: "customer_deposits",
    name: "Customer deposits",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "lease_liabilities_current",
    name: "Lease liabilities current",
    report: "liability",
    cashFlow: "cff",
    contra: false,
  },
  {
    code: "lease_liabilities_noncurrent",
    name: "Lease liabilities non-current",
    report: "liability",
    cashFlow: "cff",
    contra: false,
  },
  {
    code: "rou_assets",
    name: "Right-of-use assets",
    report: "asset",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "rou_accumulated_depreciation",
    name: "Accumulated depreciation on right-of-use assets",
    report: "asset",
    cashFlow: "non_cash",
    contra: true,
  },
  {
    code: "gain_loss_on_disposal",
    name: "Gain or loss on disposal",
    report: "revenue",
    cashFlow: "cfi",
    contra: false,
  },
  {
    code: "oci_reserves",
    name: "OCI reserves",
    report: "equity",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "intangible_assets",
    name: "Intangible assets",
    report: "asset",
    cashFlow: "cfi",
    contra: false,
  },
  {
    code: "accumulated_amortisation",
    name: "Accumulated amortization",
    report: "asset",
    cashFlow: "cfi",
    contra: true,
  },
  {
    code: "depreciation_ppe",
    name: "Depreciation of property, plant and equipment",
    report: "expense",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "depreciation_rou",
    name: "Depreciation of right-of-use assets",
    report: "expense",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "amortisation",
    name: "Amortization",
    report: "expense",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "impairment",
    name: "Impairment",
    report: "expense",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "other_current_assets",
    name: "Other current assets",
    report: "asset",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "other_current_liabilities",
    name: "Other current liabilities",
    report: "liability",
    cashFlow: "cfo",
    contra: false,
  },
  {
    code: "other_noncurrent_assets",
    name: "Other non-current assets",
    report: "asset",
    cashFlow: "non_cash",
    contra: false,
  },
  {
    code: "other_noncurrent_liabilities",
    name: "Other non-current liabilities",
    report: "liability",
    cashFlow: "non_cash",
    contra: false,
  },
];

const EXTRA_CASH_FLOWS: Readonly<Record<string, readonly CashFlowClass[]>> = {
  security_deposits_paid: ["cfo", "cfi"],
  lease_liabilities_current: ["cfo", "cff"],
  lease_liabilities_noncurrent: ["cfo", "cff"],
  other_noncurrent_assets: ["cfo", "cfi", "cff", "non_cash"],
  other_noncurrent_liabilities: ["cfo", "cfi", "cff", "non_cash"],
};

const EXTRA_REPORTS: Readonly<Record<string, readonly ReportClass[]>> = {
  gain_loss_on_disposal: ["revenue", "expense"],
};

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

/**
 * Canonical codes must use an allowed report and cash-flow class.
 * Unknown codes are caller-defined and are not rewritten.
 * Nothing here assigns non_cash by default.
 */
export function assertCanonicalClassification(input: {
  readonly code: string;
  readonly report: ReportClass;
  readonly cashFlow: CashFlowClass;
}): void {
  const account = BY_CODE.get(input.code);
  if (!account) return;
  const reports = EXTRA_REPORTS[input.code] ?? [account.report];
  const cashFlows = EXTRA_CASH_FLOWS[input.code] ?? [account.cashFlow];
  if (!reports.includes(input.report) || !cashFlows.includes(input.cashFlow)) {
    throw new KernelError(
      "FIN_INVALID_JOURNAL_LINE",
      `Account ${input.code} cannot be classified as ${input.report}/${input.cashFlow}`,
    );
  }
}

/** Current leftovers are operating. Non-current leftovers stay in review until a class is chosen. */
export function unclassifiedCashFlow(term: "current" | "noncurrent"): "cfo" | "review" {
  return term === "current" ? "cfo" : "review";
}
