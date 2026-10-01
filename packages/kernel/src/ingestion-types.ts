/** Formula version for ingestion checks and the linked-model builder. */
export const INGESTION_FORMULA_VERSION = "ingestion-checks-0.3.0";

/**
 * Mapping proposals at or above this confidence may be accepted without an exception.
 * The comparison is decimal, never a binary float.
 */
export const MAPPING_AUTO_ACCEPT_CONFIDENCE = "0.95";

/**
 * The first fifteen ids are blocking checks (severity error, with the warn cases
 * documented on each check). `prior_period_variance` is the 16th advisory check:
 * a move above 25% is info and a move above 100% is warn. It does not, by itself,
 * stop the linked model.
 */
export const INGESTION_CHECK_IDS = [
  "bs_balance",
  "subtotal_footing",
  "total_footing",
  "is_retained_earnings",
  "period_continuity",
  "sign_conventions",
  "cash_ties_bank",
  "bank_rollforward",
  "duplicates",
  "period_coverage",
  "scale_consistency",
  "currency_consistency",
  "cross_statement_dates",
  "depreciation_reasonableness",
  "missing_mandatory",
  "prior_period_variance",
] as const;

export type IngestionCheckId = (typeof INGESTION_CHECK_IDS)[number];

export type IngestionSeverity = "error" | "warn" | "info";

export type AmountScale = "units" | "thousands" | "millions" | "lakhs" | "crores";

export type IngestionStatement = "income_statement" | "balance_sheet";

export type AmountRole = "line" | "subtotal" | "total";

export type BalanceKind = "closing" | "opening" | "movement";

export interface IngestionAmount {
  readonly valueId: string;
  readonly documentId: string;
  readonly statement: IngestionStatement;
  readonly role: AmountRole;
  readonly accountCode: string | null;
  readonly label: string;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly spanMonths: number;
  readonly currency: string;
  readonly scale: AmountScale;
  readonly minor: string;
  readonly contra: boolean;
  readonly balanceKind: BalanceKind;
  readonly order: number;
}

export interface IngestionBankTransaction {
  readonly valueId: string;
  readonly date: string;
  readonly description: string;
  readonly minor: string;
  readonly fingerprint: string;
}

export interface IngestionBank {
  readonly documentId: string;
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingMinor: string;
  readonly closingMinor: string;
  readonly openingValueId: string;
  readonly closingValueId: string;
  readonly transactions: readonly IngestionBankTransaction[];
}

export interface IngestionDocument {
  readonly documentId: string;
  readonly fingerprint: string;
  readonly fileName: string;
}

export interface IngestionCoverage {
  readonly start: string;
  readonly end: string;
  readonly cadence: "monthly" | "quarterly";
}

export interface IngestionCheckInput {
  readonly currency: string;
  readonly toleranceMinor: string;
  readonly amounts: readonly IngestionAmount[];
  readonly banks: readonly IngestionBank[];
  readonly documents: readonly IngestionDocument[];
  readonly coverage: IngestionCoverage | null;
  readonly mandatoryCodes: readonly string[];
  /**
   * Ledger balances already posted for a period end, in minor units.
   * Retained earnings is the derived ending balance, not the raw journal line.
   * Periods listed here are reconciled instead of posted again.
   */
  readonly postedBalances?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface IngestionCheckFailure {
  readonly checkId: IngestionCheckId;
  readonly severity: IngestionSeverity;
  readonly message: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly diff: string | null;
  readonly valueIds: readonly string[];
}

export interface IngestionCheckResult {
  readonly checkId: IngestionCheckId;
  readonly passed: boolean;
  readonly failures: readonly IngestionCheckFailure[];
}

export interface IngestionCheckReport {
  readonly formulaVersion: string;
  readonly passed: boolean;
  readonly checks: readonly IngestionCheckResult[];
}
