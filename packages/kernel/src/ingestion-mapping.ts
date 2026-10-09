import {
  canonicalAccount,
  suggestedReviewCashFlow,
  type ReviewCashFlow,
} from "./ingestion-chart.js";
import { MAPPING_AUTO_ACCEPT_CONFIDENCE, type AmountRole } from "./ingestion-types.js";
import { AnalyticalDecimal } from "./money.js";
import { LOCALIZED_LABELS } from "./ingestion-localized-labels.js";

const localizedSynonyms = new Map(
  Object.entries(LOCALIZED_LABELS).flatMap(([code, labels]) =>
    labels.map((label) => [normalizeLabel(label), code] as const),
  ),
);

export type MappingMethod = "exact" | "synonym" | "regex";

export interface MappingHit {
  readonly accountCode: string;
  readonly confidence: string;
  readonly method: MappingMethod;
  readonly role: AmountRole;
  readonly contra: boolean;
  readonly suggestedCashFlow?: ReviewCashFlow;
}

const TOTALS = new Set([
  "total assets",
  "total liabilities and equity",
  "total equity and liabilities",
  "net income",
  "net profit",
  "nett profit",
  "profit for the period",
  "profit for the year",
  "profit loss",
]);

const EXACT: Readonly<Record<string, string>> = {
  cash: "cash",
  "accounts receivable": "accounts_receivable",
  inventory: "inventory",
  "prepaid expenses": "prepaid_expenses",
  "fixed assets": "fixed_assets",
  "accumulated depreciation": "accumulated_depreciation",
  "other assets": "other_assets",
  "accounts payable": "accounts_payable",
  "accrued expenses": "accrued_expenses",
  "short term debt": "short_term_debt",
  "long term debt": "long_term_debt",
  "other liabilities": "other_liabilities",
  "common stock": "common_stock",
  "retained earnings": "retained_earnings",
  distributions: "distributions",
  "other equity": "other_equity",
  revenue: "revenue",
  "other income": "other_income",
  "cost of goods sold": "cogs",
  "operating expenses": "operating_expenses",
  depreciation: "depreciation",
  "interest expense": "interest_expense",
  "tax expense": "tax_expense",
  "gross profit": "gross_profit",
  "net income": "net_income",
  "total assets": "total_assets",
  "total liabilities": "total_liabilities",
  "total equity": "total_equity",
  "total liabilities and equity": "total_liabilities_and_equity",
  "total expenses": "total_expenses",
  "total income": "total_income",
};

const SYNONYMS: Readonly<Record<string, string>> = {
  sales: "revenue",
  "sales accounts": "revenue",
  "revenue from operations": "revenue",
  turnover: "revenue",
  "service revenue": "revenue",
  "product sales": "revenue",
  "total income": "total_income",
  checking: "cash",
  "checking account": "cash",
  "cash and cash equivalents": "cash",
  "petty cash": "cash",
  "undeposited funds": "cash",
  bank: "cash",
  "trade receivables": "accounts_receivable",
  "sundry debtors": "accounts_receivable",
  debtors: "accounts_receivable",
  "trade payables": "accounts_payable",
  "sundry creditors": "accounts_payable",
  creditors: "accounts_payable",
  inventories: "inventory",
  "stock in hand": "inventory",
  "inventory asset": "inventory",
  "purchase accounts": "cogs",
  purchases: "cogs",
  "cost of materials consumed": "cogs",
  "cost of sales": "cogs",
  "direct expenses": "cogs",
  "indirect expenses": "operating_expenses",
  "employee benefits expense": "operating_expenses",
  "employee benefit expenses": "operating_expenses",
  "salaries and wages": "operating_expenses",
  rent: "operating_expenses",
  "office expenses": "operating_expenses",
  "general expenses": "operating_expenses",
  "other expenses": "operating_expenses",
  "finance costs": "interest_expense",
  "depreciation and amortisation": "depreciation",
  "depreciation and amortisation expense": "depreciation",
  "depreciation and amortization": "depreciation",
  "depreciation and amortization expense": "depreciation",
  "property plant and equipment": "fixed_assets",
  "tangible assets": "fixed_assets",
  "share capital": "common_stock",
  "equity share capital": "common_stock",
  "reserves and surplus": "retained_earnings",
  "profit and loss account": "retained_earnings",
  "profit and loss a c": "retained_earnings",
  "long term borrowings": "long_term_debt",
  "short term borrowings": "short_term_debt",
  "income tax expense": "tax_expense",
  "current tax": "tax_expense",
  "net profit": "net_income",
  "nett profit": "net_income",
  "profit for the period": "net_income",
  "profit for the year": "net_income",
  "opening balance equity": "other_equity",
  "merchant fees": "operating_expenses",
  "total current assets": "total_current_assets",
  "total current liabilities": "total_current_liabilities",
  "total non current assets": "total_non_current_assets",
  "total fixed assets": "total_fixed_assets",
  dividends: "distributions",
  drawings: "distributions",
};

const REGEX: readonly {
  readonly pattern: RegExp;
  readonly code: string;
  readonly contra: boolean;
}[] = [
  {
    pattern: /accumulated depreciation|provision for depreciation/,
    code: "accumulated_depreciation",
    contra: true,
  },
  { pattern: /\bdepreciat/, code: "depreciation", contra: false },
  { pattern: /\breceivable|\bdebtors\b/, code: "accounts_receivable", contra: false },
  { pattern: /\bpayable|\bcreditors\b/, code: "accounts_payable", contra: false },
  { pattern: /\bcash\b|bank balance|cash equivalents/, code: "cash", contra: false },
  {
    pattern: /\b(?<!deferred )(?<!unearned )revenue\b|(?<!cost of )\bsales\b|\bturnover\b/,
    code: "revenue",
    contra: false,
  },
  { pattern: /\binventor|\bclosing stock\b/, code: "inventory", contra: false },
  { pattern: /\bborrow/, code: "long_term_debt", contra: false },
  { pattern: /share capital|common stock/, code: "common_stock", contra: false },
  {
    pattern: /\bretained\b|reserves and surplus|profit and loss/,
    code: "retained_earnings",
    contra: false,
  },
  { pattern: /\btax expense\b|\bincome tax\b|\bcurrent tax\b/, code: "tax_expense", contra: false },
  {
    pattern: /\binterest expense\b|\bfinance cost/,
    code: "interest_expense",
    contra: false,
  },
];

/** Below auto-accept. A class or sign change never posts without review. */
const REVIEW_CONFIDENCE = "0.90";

/**
 * Structural modifiers, not a list of example labels.
 * A credit facility, a contra marker, or a head noun whose class changed
 * resolves to the corrected account and is capped below auto-accept.
 */
function semanticOverride(normalized: string): { code: string; contra: boolean } | null {
  if (/\boverdraft\b|\bcash credit\b|\bcc limit\b|\bcredit limit\b/.test(normalized)) {
    return { code: "short_term_debt", contra: false };
  }
  if (
    /\bcost of\b/.test(normalized) &&
    /\b(revenue|sales|goods|materials|services)\b/.test(normalized)
  ) {
    return { code: "cogs", contra: false };
  }
  if (/\b(deferred|unearned)\b/.test(normalized) && /\b(revenue|income|sales)\b/.test(normalized)) {
    return { code: "other_liabilities", contra: false };
  }
  if (/\bbefore tax\b/.test(normalized)) {
    return { code: "other_income", contra: false };
  }
  if (/\binterest\b/.test(normalized)) {
    const expenseSide = /\b(expense|cost|finance|borrow|loan|debt)/.test(normalized);
    const incomeSide =
      /\b(income|received|earned)\b/.test(normalized) && !/\b(expense|cost)\b/.test(normalized);
    if (incomeSide) return { code: "other_income", contra: false };
    if (expenseSide) return { code: "interest_expense", contra: false };
  }
  if (
    /\b(provision|allowance|doubtful)\b/.test(normalized) &&
    /\b(receivables?|debtors?|debts|accounts)\b/.test(normalized)
  ) {
    return { code: "accounts_receivable", contra: true };
  }
  if (
    /\b(returns?|discounts?|allowances?)\b/.test(normalized) &&
    /\b(revenue|sales|turnover|income)\b/.test(normalized)
  ) {
    return { code: "revenue", contra: true };
  }
  if (
    /\b(reserve|reserves|surplus|retained)\b/.test(normalized) &&
    /\b(revenue|profit|earnings)\b/.test(normalized)
  ) {
    const naive = baseMap(normalized);
    if (naive?.accountCode === "retained_earnings") return null;
    return { code: "retained_earnings", contra: false };
  }
  return null;
}

export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\s*(?:\d+\.|[IVXLCDM]+\.|[a-z]\))\s+/u, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function statementRole(label: string): AmountRole | "heading" {
  const normalized = normalizeLabel(label);
  if (normalized.length === 0) return "heading";
  if (TOTALS.has(normalized)) return "total";
  const localized = localizedSynonyms.get(normalized);
  if (localized === "net_income" || localized?.startsWith("total_")) return "total";
  if (
    normalized.startsWith("total ") ||
    normalized === "gross profit" ||
    normalized === "operating profit"
  ) {
    return "subtotal";
  }
  return "line";
}

function baseMap(normalized: string): MappingHit | null {
  const role = statementRole(normalized);
  if (role === "heading") return null;
  const exact = EXACT[normalized];
  if (exact) return hit(exact, "1", "exact", role);
  const synonym = SYNONYMS[normalized];
  if (synonym) return hit(synonym, "0.98", "synonym", role);
  for (const rule of REGEX) {
    if (rule.pattern.test(normalized))
      return hit(rule.code, REVIEW_CONFIDENCE, "regex", role, rule.contra);
  }
  return null;
}

/**
 * Auto-accept only an exact label or a full synonym. Extra words, including
 * current, net, total, units, and text in brackets, stay below auto-accept.
 */
export function mapLineLabel(label: string): MappingHit | null {
  if (/\[ai:/i.test(label)) return null;
  const full = mapNormalized(normalizeLabel(label));
  if (full && /[%[\]()（）]/u.test(label))
    return { ...full, confidence: REVIEW_CONFIDENCE, method: "regex" };
  return full;
}

function mapNormalized(normalized: string): MappingHit | null {
  if (normalized.length === 0) return null;
  const role = statementRole(normalized);
  if (role === "heading") return null;
  const placeholder = otherNoncurrentReview(normalized);
  if (placeholder) {
    return hit(placeholder.code, REVIEW_CONFIDENCE, "regex", role, false, placeholder.suggested);
  }
  const localized = localizedSynonyms.get(normalized);
  if (localized) return hit(localized, "0.98", "synonym", role);
  if (normalized === "borrowings" || normalized === "term loan")
    return hit("long_term_debt", REVIEW_CONFIDENCE, "regex", role);
  const exact = EXACT[normalized];
  if (exact) return hit(exact, "1", "exact", role);
  const synonym = SYNONYMS[normalized];
  if (synonym) return hit(synonym, "0.98", "synonym", role);
  const family = familyMap(normalized);
  if (family) return hit(family.code, REVIEW_CONFIDENCE, "regex", role, family.contra);
  const override = semanticOverride(normalized);
  const naive = baseMap(normalized);
  if (override) {
    const naiveAccount = naive ? canonicalAccount(naive.accountCode) : null;
    const corrected = canonicalAccount(override.code);
    const changed =
      !naive ||
      naive.accountCode !== override.code ||
      naive.contra !== override.contra ||
      naiveAccount?.report !== corrected?.report;
    if (changed) return hit(override.code, REVIEW_CONFIDENCE, "regex", role, override.contra);
  }
  return naive;
}

function otherNoncurrentReview(
  normalized: string,
): { code: string; suggested: ReviewCashFlow } | null {
  if (
    /\b(long term deposits?|deposits? given|loans? given|loans? to others)\b/.test(normalized) ||
    /\bother non current assets?\b/.test(normalized)
  ) {
    return { code: "other_noncurrent_assets", suggested: "cfi" };
  }
  if (
    /\blong term provisions?\b/.test(normalized) ||
    /\bnon current deferred revenue\b/.test(normalized) ||
    /\b(long term|non current) employee benefits?\b/.test(normalized)
  ) {
    return { code: "other_noncurrent_liabilities", suggested: "cfo" };
  }
  if (
    /\bother non current borrowings?\b/.test(normalized) ||
    /\bother borrowings\b/.test(normalized)
  ) {
    return { code: "other_noncurrent_liabilities", suggested: "cff" };
  }
  if (/\bother non current liabilities\b/.test(normalized)) {
    return { code: "other_noncurrent_liabilities", suggested: "cff" };
  }
  return null;
}

function familyMap(normalized: string): { code: string; contra: boolean } | null {
  if (/\binput tax\b/.test(normalized)) return { code: "other_assets", contra: false };
  if (
    /\b(gst|vat|tds)\b/.test(normalized) ||
    /\bsales tax\b/.test(normalized) ||
    /\boutput tax\b/.test(normalized) ||
    /\bwithholding\b/.test(normalized)
  ) {
    return { code: "other_liabilities", contra: false };
  }
  if (
    /\bhedge\b/.test(normalized) ||
    /\brevaluation\b/.test(normalized) ||
    (/\btranslation\b/.test(normalized) && /\breserve\b/.test(normalized)) ||
    /\bcapital redemption\b/.test(normalized)
  ) {
    return { code: "other_equity", contra: false };
  }
  if (
    /\bdeferred\b/.test(normalized) ||
    /\bunearned\b/.test(normalized) ||
    /\breceived in advance\b/.test(normalized) ||
    /\bcontract liabilit/.test(normalized)
  ) {
    return { code: "other_liabilities", contra: false };
  }
  if (
    /\bborrow/.test(normalized) &&
    /\bcurrent\b/.test(normalized) &&
    !/\bnon current\b/.test(normalized)
  ) {
    return { code: "short_term_debt", contra: false };
  }
  if (
    !/\binterest\b/.test(normalized) &&
    (/\bnotes payable\b/.test(normalized) ||
      /\bbills payable\b/.test(normalized) ||
      /\bdebentures?\b/.test(normalized) ||
      /\boverdraft\b/.test(normalized) ||
      /\bloans?\b/.test(normalized))
  ) {
    return { code: "short_term_debt", contra: false };
  }
  if (/\ballowance\b|\bprovision\b|\baccumulated\b|\bless\b|\bimpairment\b/.test(normalized)) {
    if (/\bdepreciat|\bamort/.test(normalized)) {
      return { code: "accumulated_depreciation", contra: true };
    }
    if (/\binventor|\bclosing stock\b|\bstock in hand\b/.test(normalized)) {
      return { code: "inventory", contra: true };
    }
    if (/\breceivable|\bdebtor|\bdebts\b/.test(normalized)) {
      return { code: "accounts_receivable", contra: true };
    }
    if (/\b(plant|equipment|fixed|ppe)\b/.test(normalized)) {
      return { code: "fixed_assets", contra: true };
    }
    if (/\b(revenue|sales|turnover)\b/.test(normalized)) return { code: "revenue", contra: true };
  }
  return null;
}

export function mappingIsAutoAcceptable(confidence: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(confidence)) return false;
  return new AnalyticalDecimal(confidence).gte(MAPPING_AUTO_ACCEPT_CONFIDENCE);
}

function hit(
  accountCode: string,
  confidence: string,
  method: MappingMethod,
  role: AmountRole,
  contra = false,
  suggestedCashFlow?: ReviewCashFlow,
): MappingHit {
  const account = canonicalAccount(accountCode);
  const suggested = suggestedCashFlow ?? suggestedReviewCashFlow(accountCode, "") ?? undefined;
  return {
    accountCode,
    confidence,
    method,
    role,
    contra: contra || account?.contra === true,
    ...(suggested === undefined ? {} : { suggestedCashFlow: suggested }),
  };
}
