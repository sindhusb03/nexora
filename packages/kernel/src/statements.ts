import Decimal from "decimal.js";

import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { assertCurrency, parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export type ReportClass = "asset" | "liability" | "equity" | "revenue" | "expense";
export type CashFlowClass = "cash" | "cfo" | "cfi" | "cff" | "non_cash" | "distribution";
export type LeaseAccounting = "ifrs16" | "asc842_finance" | "asc842_operating";
export type StatementIssueCode =
  | "depreciation_split_needed"
  | "lease_additions_needed"
  | "disposal_gain_unmapped"
  | "possible_non_cash_exchange"
  | "asset_sale_in_trade_receivable"
  | "other_noncurrent_review";

export type NonCashItemType =
  "deferred_consideration" | "asset_acquired_with_debt" | "capex_on_credit";

export interface StatementPolicy {
  readonly leaseAccounting?: LeaseAccounting;
  readonly interestPaid?: "cfo" | "cff";
}

/**
 * IFRS 16 is the statement default until an entity framework is stored.
 * Callers may still pass ASC 842. The API does not, because that setting
 * needs an approved schema change.
 */
export const DEFAULT_STATEMENT_POLICY: StatementPolicy = { leaseAccounting: "ifrs16" };

export function statementPolicyLabel(leaseAccounting: LeaseAccounting = "ifrs16"): string {
  if (leaseAccounting === "asc842_finance") return "ASC 842 finance";
  if (leaseAccounting === "asc842_operating") return "ASC 842 operating";
  return "IFRS 16";
}

export interface ClassifiedLine {
  readonly journalId?: string;
  readonly accountId: string;
  readonly accountCode?: string;
  readonly journalKind?: "opening" | "standard";
  readonly sourceLabel?: string;
  readonly report: ReportClass;
  readonly cashFlow: CashFlowClass;
  readonly debitMinor: string;
  readonly creditMinor: string;
  readonly currency: string;
  /** Opening lines are posted activity from earlier periods. They are not rewritten. */
  readonly period: "opening" | "movement";
  /** Period end of the source activity, when the caller has it. Year-to-date uses it. */
  readonly periodEnd?: string;
}

/**
 * Fiscal year already stored on the entity. A mid-year opening keeps this year's
 * income in one before-Nexora bucket. A start on the year boundary folds it into
 * prior retained earnings. Omitted means every opening income line is prior.
 */
export interface StatementFiscalYear {
  readonly openingDate: string;
  readonly statementDate: string;
  readonly yearEndMonth: number;
  readonly yearEndDay: number;
}

export interface StatementFinding {
  readonly code: StatementIssueCode;
  readonly severity: "error" | "notice";
  readonly sourceLabel: string | null;
  readonly message: string;
}

export interface StatementSet {
  readonly engineVersion: string;
  readonly currency: string;
  readonly inputHash: string;
  readonly incomeStatement: {
    readonly revenueMinor: string;
    readonly expensesMinor: string;
    readonly netIncomeMinor: string;
  };
  /**
   * Income from the opening journal only, when that journal is inside the
   * current fiscal year. One column, never added to a month, and never a cash
   * flow. Null when the opening is on a year boundary or there is no
   * current-year opening income.
   */
  readonly beforeNexora: {
    readonly revenueMinor: string;
    readonly expensesMinor: string;
    readonly netIncomeMinor: string;
    readonly profitBeforeTaxMinor: string;
    readonly taxExpenseMinor: string;
  } | null;
  /**
   * Before Nexora plus every same-year month through this statement.
   * The annual tax rate uses this total. A month's income statement does not.
   */
  readonly yearToDate: {
    readonly revenueMinor: string;
    readonly expensesMinor: string;
    readonly netIncomeMinor: string;
    readonly profitBeforeTaxMinor: string;
    readonly taxExpenseMinor: string;
  };
  readonly effectiveTax: {
    readonly profitBeforeTaxMinor: string;
    readonly taxExpenseMinor: string;
    readonly effectiveTaxRate: string | null;
  };
  readonly balanceSheet: {
    readonly assetsMinor: string;
    readonly liabilitiesMinor: string;
    readonly equityMinor: string;
  };
  readonly cashFlow: {
    readonly beginningCashMinor: string;
    readonly cfoMinor: string;
    readonly cfiMinor: string;
    readonly cffMinor: string;
    readonly endingCashMinor: string;
  };
  readonly retainedEarnings: {
    readonly openingMinor: string;
    readonly beforeNexoraMinor: string;
    readonly netIncomeMinor: string;
    readonly distributionsMinor: string;
    readonly directEntriesMinor: string;
    readonly endingMinor: string;
    readonly close: "derived";
  };
  readonly nonCash: {
    readonly leaseAdditionsMinor: string;
    readonly items: readonly {
      readonly type: NonCashItemType;
      readonly amountMinor: string;
      readonly message: string;
    }[];
  };
  readonly issues: readonly StatementFinding[];
  readonly notices: readonly StatementFinding[];
}

interface AccountPosition {
  report: ReportClass;
  cashFlow: CashFlowClass;
  opening: bigint;
  movementDebit: bigint;
  movementCredit: bigint;
}

interface Flows {
  cfo: bigint;
  cfi: bigint;
  cff: bigint;
}

interface Move {
  debit: bigint;
  credit: bigint;
}

const SPECIAL = new Set([
  "accumulated_depreciation",
  "accumulated_amortisation",
  "rou_accumulated_depreciation",
  "rou_assets",
  "lease_liabilities_current",
  "lease_liabilities_noncurrent",
  "gain_loss_on_disposal",
  "deferred_tax_asset",
  "deferred_tax_liability",
]);

const DA_CODES = new Set([
  "depreciation",
  "depreciation_ppe",
  "depreciation_rou",
  "amortisation",
  "impairment",
]);

const OCI_CODES = new Set([
  "oci_reserves",
  "translation_reserve",
  "revaluation_reserve",
  "hedge_reserve",
]);

const ACCUM_CODES = [
  "accumulated_depreciation",
  "accumulated_amortisation",
  "rou_accumulated_depreciation",
] as const;

const GROSS_CODES = ["fixed_assets", "intangible_assets", "rou_assets"] as const;

/**
 * Derives the three statements and the retained-earnings roll-forward.
 * The income close into retained earnings is a presentation derivation.
 * Source lines are not mutated. The income statement is this period's movement
 * only. An opening journal inside the current fiscal year is the before-Nexora
 * column and its own retained-earnings line. Earlier months stay in those
 * months and in year-to-date. Opening income on a year boundary rolls into
 * retained earnings.
 *
 * Debit-positive convention: closing = opening + debit - credit.
 * With complete journal IDs, each cash journal is classified by the full
 * counter-line (credit − debit), not pro rata. Opening journals are balance-sheet
 * only. Direct retained-earnings entries stay in the equity roll-forward.
 */
export function buildStatements(input: {
  readonly currency: string;
  readonly retainedEarningsAccountId: string;
  readonly lines: readonly ClassifiedLine[];
  readonly policy?: StatementPolicy;
  readonly fiscalYear?: StatementFiscalYear;
}): StatementSet {
  const currency = assertCurrency(input.currency);
  if (input.retainedEarningsAccountId.length === 0) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Retained earnings account is required");
  }

  const accounts = new Map<string, AccountPosition>();
  const codeByAccount = new Map<string, string>();

  for (const line of input.lines) {
    if (line.currency !== currency) {
      throw new KernelError("FIN_CURRENCY_MISMATCH", "Statements require a single currency");
    }
    const debit = parseMinor(line.debitMinor);
    const credit = parseMinor(line.creditMinor);
    if (debit < 0n || credit < 0n) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Statement lines cannot be negative");
    }
    if (line.accountCode) codeByAccount.set(line.accountId, line.accountCode);

    const existing = accounts.get(line.accountId);
    if (existing) {
      if (existing.report !== line.report || existing.cashFlow !== line.cashFlow) {
        throw new KernelError(
          "FIN_STATEMENT_IMBALANCE",
          `Account ${line.accountId} has conflicting classification`,
        );
      }
    } else {
      accounts.set(line.accountId, {
        report: line.report,
        cashFlow: line.cashFlow,
        opening: 0n,
        movementDebit: 0n,
        movementCredit: 0n,
      });
    }

    const position = accounts.get(line.accountId);
    if (!position) {
      throw new KernelError("FIN_STATEMENT_IMBALANCE", "Account position missing");
    }
    if (linePeriod(line) === "opening") {
      position.opening += debit - credit;
    } else {
      position.movementDebit += debit;
      position.movementCredit += credit;
    }
  }

  const retained = accounts.get(input.retainedEarningsAccountId);
  if (retained && retained.cashFlow === "distribution") {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      "Retained earnings cannot be classified as a distribution account",
    );
  }

  let balanceCheck = 0n;
  let priorEarnings = 0n;
  let assets = 0n;
  let liabilities = 0n;
  let otherEquity = 0n;
  let beginningCash = 0n;
  let endingCash = 0n;
  let distributions = 0n;
  const carryOpeningIncome = carriesCurrentYearOpening(input.fiscalYear);
  const income = splitIncome(input.lines, carryOpeningIncome, input.fiscalYear);
  const movementLines = input.lines.filter((line) => linePeriod(line) === "movement");
  const journalCashFlow = movementLines.every((line) => line.journalId !== undefined);
  const flows: Flows = { cfo: 0n, cfi: 0n, cff: 0n };
  priorEarnings += income.priorEarnings;

  for (const [accountId, position] of accounts) {
    const closing = position.opening + position.movementDebit - position.movementCredit;
    balanceCheck += closing;

    if (position.report === "revenue" || position.report === "expense") {
      // Month, before-Nexora, and year-to-date are taken from the lines above.
    } else if (position.report === "asset") {
      assets += closing;
    } else if (position.report === "liability") {
      liabilities += -closing;
    } else if (accountId === input.retainedEarningsAccountId) {
      // Folded into the derived retained-earnings close below.
    } else if (position.cashFlow === "distribution") {
      priorEarnings -= position.opening;
      distributions += position.movementDebit - position.movementCredit;
    } else if (position.report === "equity") {
      otherEquity += -closing;
    }

    if (position.cashFlow === "cash") {
      beginningCash += position.opening;
      endingCash += closing;
    }
  }

  const journals = groupJournals(movementLines);
  if (!journalCashFlow) {
    for (const [accountId, position] of accounts) {
      if (isSpecialCode(codeByAccount.get(accountId))) continue;
      addFlow(flows, position.cashFlow, position.movementCredit - position.movementDebit);
    }
  } else {
    for (const lines of journals.values()) {
      classifyJournal(lines, flows, input.retainedEarningsAccountId, input.policy);
    }
  }

  const moves = codeMoves(movementLines);
  applyDisposals(flows, movementLines, journals, !journalCashFlow);
  applyDeferredTax(flows, journals, journalCashFlow, movementLines);
  const lease = leaseAdditions(moves, movementLines);
  const findings = collectFindings(input.lines, movementLines, journals, moves, lease.error);

  if (lease.error) {
    const blocked = findings.some(
      (finding) => finding.code === "depreciation_split_needed" && finding.severity === "error",
    );
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      blocked ? "lease_additions_needed. depreciation_split_needed" : "lease_additions_needed",
    );
  }

  applyLeaseCash(
    flows,
    moves,
    lease.additions,
    lease.excusedRise,
    input.policy?.leaseAccounting ?? "ifrs16",
    movementLines,
  );
  if (balanceCheck !== 0n) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Classified lines are not in balance");
  }

  const revenue = income.period.revenue;
  const expenses = income.period.expenses;
  const netIncome = revenue - expenses;
  const beforeNet = income.before.revenue - income.before.expenses;
  const directEntries = retained ? retained.movementCredit - retained.movementDebit : 0n;
  const openingRetained = (retained ? -retained.opening : 0n) + priorEarnings;
  const endingRetained = openingRetained + beforeNet + netIncome - distributions + directEntries;
  const yearToDate = combineIncome(income.period, income.before, income.sameYear);
  const equity = otherEquity + endingRetained;

  if (assets !== liabilities + equity) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      "Balance sheet does not satisfy assets = liabilities + equity",
    );
  }
  if (beginningCash + flows.cfo + flows.cfi + flows.cff !== endingCash) {
    const blocked = findings.some(
      (finding) => finding.code === "depreciation_split_needed" && finding.severity === "error",
    );
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      blocked
        ? "depreciation_split_needed"
        : "The cash flow does not roll forward to the ending cash balance.",
    );
  }

  const issues = findings.filter((finding) => finding.severity === "error");
  const notices = findings.filter((finding) => finding.severity === "notice");

  return {
    engineVersion: ENGINE_VERSION,
    currency,
    inputHash: hashMaterial({
      currency,
      retainedEarningsAccountId: input.retainedEarningsAccountId,
      ...policyMaterial(input.policy),
      ...(input.fiscalYear === undefined
        ? {}
        : {
            fiscalYear: {
              openingDate: input.fiscalYear.openingDate,
              statementDate: input.fiscalYear.statementDate,
              yearEndMonth: String(input.fiscalYear.yearEndMonth),
              yearEndDay: String(input.fiscalYear.yearEndDay),
            },
          }),
      lines: input.lines.map((line) => ({
        ...(line.journalId === undefined ? {} : { journalId: line.journalId }),
        accountId: line.accountId,
        ...(line.accountCode === undefined ? {} : { accountCode: line.accountCode }),
        ...(line.journalKind === undefined ? {} : { journalKind: line.journalKind }),
        ...(line.sourceLabel === undefined ? {} : { sourceLabel: line.sourceLabel }),
        ...(line.periodEnd === undefined ? {} : { periodEnd: line.periodEnd }),
        report: line.report,
        cashFlow: line.cashFlow,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency: line.currency,
        period: line.period,
      })),
    }),
    incomeStatement: {
      revenueMinor: revenue.toString(),
      expensesMinor: expenses.toString(),
      netIncomeMinor: netIncome.toString(),
    },
    beforeNexora: beforeNexoraResult(
      income.before.revenue,
      income.before.expenses,
      income.before.tax,
    ),
    yearToDate: yearToDateResult(yearToDate),
    effectiveTax: effectiveTaxResult(yearToDate.revenue - yearToDate.expenses, yearToDate.tax),
    balanceSheet: {
      assetsMinor: assets.toString(),
      liabilitiesMinor: liabilities.toString(),
      equityMinor: equity.toString(),
    },
    cashFlow: {
      beginningCashMinor: beginningCash.toString(),
      cfoMinor: flows.cfo.toString(),
      cfiMinor: flows.cfi.toString(),
      cffMinor: flows.cff.toString(),
      endingCashMinor: endingCash.toString(),
    },
    retainedEarnings: {
      openingMinor: openingRetained.toString(),
      beforeNexoraMinor: beforeNet.toString(),
      netIncomeMinor: netIncome.toString(),
      distributionsMinor: distributions.toString(),
      directEntriesMinor: directEntries.toString(),
      endingMinor: endingRetained.toString(),
      close: "derived",
    },
    nonCash: {
      leaseAdditionsMinor: lease.additions.toString(),
      items: nonCashItems(input.lines),
    },
    issues,
    notices,
  };
}

function linePeriod(line: ClassifiedLine): "opening" | "movement" {
  return line.journalKind === "opening" ? "opening" : line.period;
}

function effect(line: ClassifiedLine): bigint {
  return parseMinor(line.creditMinor) - parseMinor(line.debitMinor);
}

function isSpecialCode(code: string | undefined): boolean {
  return code !== undefined && SPECIAL.has(code);
}

function isSpecial(line: ClassifiedLine): boolean {
  return isSpecialCode(line.accountCode);
}

function isDa(line: ClassifiedLine): boolean {
  return line.accountCode !== undefined && DA_CODES.has(line.accountCode);
}

function isOci(line: ClassifiedLine): boolean {
  return line.accountCode !== undefined && OCI_CODES.has(line.accountCode);
}

function addFlow(flows: Flows, cashFlow: CashFlowClass, amount: bigint): void {
  if (amount === 0n) return;
  if (cashFlow === "cfo") flows.cfo += amount;
  else if (cashFlow === "cfi") flows.cfi += amount;
  else if (cashFlow === "cff" || cashFlow === "distribution") flows.cff += amount;
}

function sectionFor(line: ClassifiedLine, policy: StatementPolicy | undefined): CashFlowClass {
  if (line.accountCode === "interest_expense" && policy?.interestPaid) return policy.interestPaid;
  return line.cashFlow;
}

function groupJournals(lines: readonly ClassifiedLine[]): Map<string, ClassifiedLine[]> {
  const journals = new Map<string, ClassifiedLine[]>();
  for (const line of lines) {
    if (line.journalId === undefined) continue;
    const journal = journals.get(line.journalId) ?? [];
    journal.push(line);
    journals.set(line.journalId, journal);
  }
  return journals;
}

function classifyJournal(
  lines: readonly ClassifiedLine[],
  flows: Flows,
  retainedEarningsAccountId: string,
  policy: StatementPolicy | undefined,
): void {
  const cashDelta = lines.reduce(
    (sum, line) =>
      sum +
      (line.cashFlow === "cash" ? parseMinor(line.debitMinor) - parseMinor(line.creditMinor) : 0n),
    0n,
  );
  if (cashDelta === 0n) {
    if (lines.some((line) => line.accountId === retainedEarningsAccountId)) return;
    // A non-cash journal whose other side is not operating (share-based pay,
    // a credit sale) must not push the operating leg into CFO on its own.
    // That leg is the add-back, so the net cash effect stays zero.
    if (settlesOutsideOperating(lines)) return;
    for (const line of lines) {
      if (line.cashFlow !== "cfo" || isSpecial(line) || isDa(line)) continue;
      addFlow(flows, "cfo", effect(line));
    }
    return;
  }

  const settlement = lines.reduce((sum, line) => {
    if (line.cashFlow === "cash") return sum;
    return sum + parseMinor(cashDelta > 0n ? line.creditMinor : line.debitMinor);
  }, 0n);
  const journalId = lines[0]?.journalId ?? "";
  if (settlement === 0n) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      `Journal ${journalId} cash movement has no counterpart`,
    );
  }
  if (deferredTaxIsSoleCashCounter(lines)) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Deferred tax is never cash-settled");
  }

  let otherNonCash = 0n;
  for (const line of lines) {
    if (line.cashFlow === "cash" || isSpecial(line) || isDa(line)) continue;
    if (line.cashFlow === "non_cash" || isOci(line) || isReviewNoncurrent(line)) {
      otherNonCash += effect(line);
      continue;
    }
    addFlow(flows, sectionFor(line, policy), effect(line));
  }
  if (otherNonCash !== 0n) {
    const review = lines.find((line) => isReviewNoncurrent(line) && effect(line) !== 0n);
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      review ? reviewNoncurrentMessage(review) : `Journal ${journalId}: Cash classification needed`,
    );
  }
}

function codeMoves(lines: readonly ClassifiedLine[]): Map<string, Move> {
  const moves = new Map<string, Move>();
  for (const line of lines) {
    if (!line.accountCode) continue;
    const current = moves.get(line.accountCode) ?? { debit: 0n, credit: 0n };
    current.debit += parseMinor(line.debitMinor);
    current.credit += parseMinor(line.creditMinor);
    moves.set(line.accountCode, current);
  }
  return moves;
}

function moveOf(moves: Map<string, Move>, code: string): Move {
  return moves.get(code) ?? { debit: 0n, credit: 0n };
}

function mapped(lines: readonly ClassifiedLine[], code: string): boolean {
  return lines.some((line) => line.accountCode === code);
}

function expenseNet(moves: Map<string, Move>, code: string): bigint {
  const move = moveOf(moves, code);
  return move.debit - move.credit;
}

function applyDisposals(
  flows: Flows,
  lines: readonly ClassifiedLine[],
  journals: Map<string, ClassifiedLine[]>,
  legacy: boolean,
): void {
  // Journal path: accumulated depreciation and gain or loss are classified
  // only inside cash journals. A non-cash disposal contributes nothing.
  // The residual method stays on the line-level path, where journal ids are incomplete.
  const scoped = legacy ? lines : cashJournalLines(lines, journals);
  flows.cfi += residual(scoped, journals, "accumulated_depreciation", [
    "depreciation_ppe",
    "depreciation",
    "impairment",
  ]);
  flows.cfi += residual(scoped, journals, "accumulated_amortisation", [
    "amortisation",
    "depreciation",
    "impairment",
  ]);
  for (const line of scoped) {
    if (line.accountCode !== "gain_loss_on_disposal") continue;
    flows.cfi += effect(line);
  }
  flows.cfi -= impairmentCredits(lines, journals, "fixed_assets", legacy);
  flows.cfi -= impairmentCredits(lines, journals, "intangible_assets", legacy);
}

function cashJournalLines(
  lines: readonly ClassifiedLine[],
  journals: Map<string, ClassifiedLine[]>,
): ClassifiedLine[] {
  return lines.filter((line) => {
    if (line.journalId === undefined) return false;
    const journal = journals.get(line.journalId);
    return journal !== undefined && cashDeltaOf(journal) !== 0n;
  });
}

function residual(
  lines: readonly ClassifiedLine[],
  journals: Map<string, ClassifiedLine[]>,
  accumCode: string,
  expenseCodes: readonly string[],
): bigint {
  let delta = 0n;
  let charges = 0n;
  const allowed = new Set(expenseCodes);
  for (const line of lines) {
    if (line.accountCode !== accumCode) continue;
    delta += effect(line);
    const credit = parseMinor(line.creditMinor);
    if (credit === 0n || line.journalId === undefined) continue;
    const journal = journals.get(line.journalId) ?? [];
    if (
      journal.some((other) => other.accountCode !== undefined && allowed.has(other.accountCode))
    ) {
      charges += credit;
    }
  }
  return delta - charges;
}

function impairmentCredits(
  lines: readonly ClassifiedLine[],
  journals: Map<string, ClassifiedLine[]>,
  assetCode: string,
  legacy: boolean,
): bigint {
  let credits = 0n;
  for (const line of lines) {
    if (line.accountCode !== assetCode || line.journalId === undefined) continue;
    const credit = parseMinor(line.creditMinor);
    if (credit === 0n) continue;
    const journal = journals.get(line.journalId) ?? [];
    if (!journal.some((other) => other.accountCode === "impairment")) continue;
    if (!legacy) {
      const cash = journal.reduce(
        (sum, other) =>
          sum +
          (other.cashFlow === "cash"
            ? parseMinor(other.debitMinor) - parseMinor(other.creditMinor)
            : 0n),
        0n,
      );
      if (cash === 0n) continue;
    }
    credits += credit;
  }
  return credits;
}

function settlesOutsideOperating(lines: readonly ClassifiedLine[]): boolean {
  return lines.some(
    (line) =>
      line.cashFlow !== "cash" && line.cashFlow !== "cfo" && !isSpecial(line) && !isDa(line),
  );
}

function cashDeltaOf(lines: readonly ClassifiedLine[]): bigint {
  return lines.reduce(
    (sum, line) =>
      sum +
      (line.cashFlow === "cash" ? parseMinor(line.debitMinor) - parseMinor(line.creditMinor) : 0n),
    0n,
  );
}

function isDeferredTax(line: ClassifiedLine): boolean {
  return line.accountCode === "deferred_tax_asset" || line.accountCode === "deferred_tax_liability";
}

/** A deferred-tax leg is an error only when it is the sole counter to cash. */
function deferredTaxIsSoleCashCounter(lines: readonly ClassifiedLine[]): boolean {
  const moved = lines.some((line) => isDeferredTax(line) && effect(line) !== 0n);
  if (!moved || cashDeltaOf(lines) === 0n) return false;
  const hasExpense = lines.some((line) => line.report === "expense");
  const hasEquityOrOci = lines.some((line) => line.report === "equity" || isOci(line));
  return !hasExpense && !hasEquityOrOci;
}

function applyDeferredTax(
  flows: Flows,
  journals: Map<string, ClassifiedLine[]>,
  journalCashFlow: boolean,
  lines: readonly ClassifiedLine[],
): void {
  const groups = journalCashFlow ? journals.values() : [lines];
  for (const journal of groups) {
    if (!deferredTaxAdjustsOperating(journal)) continue;
    for (const line of journal) {
      if (isDeferredTax(line)) flows.cfo += effect(line);
    }
  }
}

/**
 * Deferred tax booked through OCI or equity nets with that reserve and stays
 * out of the cash flow. A tax-expense counterpart is the operating add-back.
 */
function deferredTaxAdjustsOperating(lines: readonly ClassifiedLine[]): boolean {
  if (!lines.some(isDeferredTax)) return false;
  const hasExpense = lines.some((line) => line.report === "expense");
  const hasEquityOrOci = lines.some((line) => line.report === "equity" || isOci(line));
  if (hasEquityOrOci && !hasExpense) return false;
  return true;
}

function leaseAdditions(
  moves: Map<string, Move>,
  lines: readonly ClassifiedLine[],
): { additions: bigint; error: boolean; excusedRise: bigint } {
  const none = { additions: 0n, error: false, excusedRise: 0n };
  const rou = moveOf(moves, "rou_assets");
  const accum = moveOf(moves, "rou_accumulated_depreciation");
  const current = moveOf(moves, "lease_liabilities_current");
  const noncurrent = moveOf(moves, "lease_liabilities_noncurrent");
  const rouMoved = rou.debit !== 0n || rou.credit !== 0n;
  const accumMoved = accum.debit !== 0n || accum.credit !== 0n;
  const liabMoved = current.debit + current.credit + noncurrent.debit + noncurrent.credit !== 0n;
  if (!rouMoved && !liabMoved && !accumMoved) return none;

  const depRou = expenseNet(moves, "depreciation_rou");
  const combined = expenseNet(moves, "depreciation");
  const inseparable = combined !== 0n && depRou === 0n;
  // A zero-amount line is not movement, so it does not count as mapped.
  const grossMapped = rouMoved && accumMoved;
  if (!rouMoved) {
    const accumDelta = accum.credit - accum.debit;
    if (accumDelta < 0n && inseparable) return { additions: 0n, error: true, excusedRise: 0n };
    const rise = leaseLiabilityRise(moves);
    const excused = excusedLeaseRise(lines, moves);
    if (rise > excused) return { additions: 0n, error: true, excusedRise: 0n };
    return { additions: 0n, error: false, excusedRise: excused };
  }
  if (grossMapped) {
    const accumDelta = accum.credit - accum.debit;
    const grossDelta = rou.debit - rou.credit;
    if (accumDelta < 0n && inseparable) return { additions: 0n, error: true, excusedRise: 0n };
    if (accumDelta < 0n) {
      return { additions: grossDelta + (depRou - accumDelta), error: false, excusedRise: 0n };
    }
    return { additions: grossDelta, error: false, excusedRise: 0n };
  }
  if (inseparable) return { additions: 0n, error: true, excusedRise: 0n };
  const addBack = depRou > 0n ? depRou : rou.credit;
  return { additions: rou.debit - rou.credit + addBack, error: false, excusedRise: 0n };
}

function leaseLiabilityRise(moves: Map<string, Move>): bigint {
  const current = moveOf(moves, "lease_liabilities_current");
  const noncurrent = moveOf(moves, "lease_liabilities_noncurrent");
  return current.credit - current.debit + (noncurrent.credit - noncurrent.debit);
}

/**
 * A rise with no right-of-use movement is a new lease unless the same journal
 * books lease interest, or a foreign-exchange remeasurement, that explains it.
 * Interest in another journal, including bank interest in the same month, does
 * not cover the rise. Cover cannot exceed that journal's rise.
 */
function excusedLeaseRise(lines: readonly ClassifiedLine[], moves: Map<string, Move>): bigint {
  const rise = leaseLiabilityRise(moves);
  if (rise <= 0n) return 0n;
  let cover = 0n;
  for (const journal of groupJournals(lines).values()) {
    let journalRise = 0n;
    let interest = 0n;
    let fxLoss = 0n;
    for (const line of journal) {
      if (
        line.accountCode === "lease_liabilities_current" ||
        line.accountCode === "lease_liabilities_noncurrent"
      ) {
        journalRise += parseMinor(line.creditMinor) - parseMinor(line.debitMinor);
      }
      if (line.accountCode === "interest_expense") {
        const booked = parseMinor(line.debitMinor) - parseMinor(line.creditMinor);
        if (booked > 0n) interest += booked;
      }
      if (!isExchangeGainLoss(line)) continue;
      const loss = parseMinor(line.debitMinor) - parseMinor(line.creditMinor);
      if (loss > 0n) fxLoss += loss;
    }
    if (journalRise <= 0n) continue;
    const journalCover = interest + fxLoss;
    cover += journalCover < journalRise ? journalCover : journalRise;
  }
  return cover < rise ? cover : rise;
}

/**
 * A non-cash FX loss on a lease liability is pushed into operating cash
 * because the liability is a special account. Add that loss back so the
 * remeasurement does not become operating or financing cash.
 */
function nonCashFxLeaseAddBack(lines: readonly ClassifiedLine[]): bigint {
  let addBack = 0n;
  for (const journal of groupJournals(lines).values()) {
    if (cashDeltaOf(journal) !== 0n) continue;
    let journalRise = 0n;
    let fxLoss = 0n;
    for (const line of journal) {
      if (
        line.accountCode === "lease_liabilities_current" ||
        line.accountCode === "lease_liabilities_noncurrent"
      ) {
        journalRise += parseMinor(line.creditMinor) - parseMinor(line.debitMinor);
      }
      if (!isExchangeGainLoss(line) || line.cashFlow !== "cfo") continue;
      const loss = parseMinor(line.debitMinor) - parseMinor(line.creditMinor);
      if (loss > 0n) fxLoss += loss;
    }
    if (journalRise > 0n && fxLoss > 0n) addBack += fxLoss < journalRise ? fxLoss : journalRise;
  }
  return addBack;
}

function isExchangeGainLoss(line: ClassifiedLine): boolean {
  if (line.accountCode === "exchange_gain_loss") return true;
  const label = line.sourceLabel ?? "";
  return /\b(foreign exchange|exchange gain|exchange loss|fx gain|fx loss)\b/i.test(label);
}

function applyLeaseCash(
  flows: Flows,
  moves: Map<string, Move>,
  additions: bigint,
  excusedRise: bigint,
  leaseAccounting: LeaseAccounting,
  lines: readonly ClassifiedLine[],
): void {
  if (
    additions === 0n &&
    excusedRise === 0n &&
    !lines.some((line) => line.accountCode?.startsWith("lease_liabilities"))
  ) {
    return;
  }
  const current = moveOf(moves, "lease_liabilities_current");
  const noncurrent = moveOf(moves, "lease_liabilities_noncurrent");
  const delta = current.credit - current.debit + (noncurrent.credit - noncurrent.debit);
  const portion = delta - additions - excusedRise;
  flows.cfo += nonCashFxLeaseAddBack(lines);
  if (leaseAccounting === "asc842_operating") flows.cfo += portion;
  else flows.cff += portion;
  if (leaseAccounting === "asc842_operating" && expenseNet(moves, "depreciation_rou") === 0n) {
    const accum = moveOf(moves, "rou_accumulated_depreciation");
    const rou = moveOf(moves, "rou_assets");
    const accumMapped = lines.some((line) => line.accountCode === "rou_accumulated_depreciation");
    flows.cfo += accumMapped ? accum.credit : rou.credit;
  }
}

function collectFindings(
  allLines: readonly ClassifiedLine[],
  lines: readonly ClassifiedLine[],
  journals: Map<string, ClassifiedLine[]>,
  moves: Map<string, Move>,
  leaseError: boolean,
): StatementFinding[] {
  const findings: StatementFinding[] = [];
  for (const line of lines) {
    if (line.accountCode !== "depreciation" || !line.sourceLabel) continue;
    if (!/impairment/i.test(line.sourceLabel)) continue;
    if (parseMinor(line.debitMinor) === 0n && parseMinor(line.creditMinor) === 0n) continue;
    findings.push({
      code: "depreciation_split_needed",
      severity: "notice",
      sourceLabel: line.sourceLabel,
      message: `“${line.sourceLabel}” combines PP&E depreciation with other charges. Split it so asset sales are read correctly.`,
    });
  }

  const combined = lines.some(
    (line) =>
      line.accountCode === "depreciation" &&
      (parseMinor(line.debitMinor) !== 0n || parseMinor(line.creditMinor) !== 0n),
  );
  if (combined) {
    const label =
      lines.find((line) => line.accountCode === "depreciation" && line.sourceLabel)?.sourceLabel ??
      "Depreciation & amortization";
    const accum = ACCUM_CODES.filter((code) => mapped(lines, code));
    const charge = chargeCredits(lines, journals, accum, DA_CODES);
    const summed = accum.reduce(
      (sum, code) => sum + (moveOf(moves, code).credit - moveOf(moves, code).debit),
      0n,
    );
    const gap = absBig(charge - summed);
    const tolerance = BigInt(accum.length);
    const grossFell = GROSS_CODES.some((code) => {
      const move = moveOf(moves, code);
      return move.credit > move.debit;
    });
    const blocked = grossFell || (accum.length > 0 && gap > tolerance);
    findings.push({
      code: "depreciation_split_needed",
      severity: blocked ? "error" : "notice",
      sourceLabel: null,
      message: `“${label}” combines PP&E depreciation with other charges. Split it so asset sales are read correctly.`,
    });
  }

  if (leaseError) {
    findings.push({
      code: "lease_additions_needed",
      severity: "error",
      sourceLabel: null,
      message:
        "We can't tell new leases apart from lease payments. Map right-of-use depreciation separately.",
    });
  }

  const gain = moveOf(moves, "gain_loss_on_disposal");
  const released =
    residual(lines, journals, "accumulated_depreciation", [
      "depreciation_ppe",
      "depreciation",
      "impairment",
    ]) < 0n ||
    residual(lines, journals, "accumulated_amortisation", [
      "amortisation",
      "depreciation",
      "impairment",
    ]) < 0n;
  if (released && gain.debit === 0n && gain.credit === 0n) {
    findings.push({
      code: "disposal_gain_unmapped",
      severity: "notice",
      sourceLabel: null,
      message:
        "An asset was sold but no gain or loss on disposal is mapped. Investing cash may be understated.",
    });
  }

  for (const journal of journals.values()) {
    if (hasInvestingFinancingExchange(journal)) {
      findings.push({
        code: "possible_non_cash_exchange",
        severity: "notice",
        sourceLabel: null,
        message:
          "This journal may mix a cash payment with a non-cash exchange. Review the investing and financing lines before you rely on the cash flow.",
      });
    }
    if (tradeReceivableDisposal(journal)) {
      findings.push({
        code: "asset_sale_in_trade_receivable",
        severity: "notice",
        sourceLabel: null,
        message:
          "This asset sale was recorded in trade receivables. Use an asset-sale receivable so customer collections stay in operating cash flow.",
      });
    }
  }

  const movedCodes = new Set<string>();
  for (const line of lines) {
    if (!isReviewNoncurrent(line)) continue;
    if (parseMinor(line.debitMinor) === 0n && parseMinor(line.creditMinor) === 0n) continue;
    if (line.accountCode === undefined || movedCodes.has(line.accountCode)) continue;
    movedCodes.add(line.accountCode);
    findings.push({
      code: "other_noncurrent_review",
      severity: "error",
      sourceLabel: line.sourceLabel ?? null,
      message: reviewNoncurrentMessage(line),
    });
  }
  if (movedCodes.size === 0) {
    const open = allLines.find(
      (line) =>
        isReviewNoncurrent(line) &&
        (parseMinor(line.debitMinor) !== 0n || parseMinor(line.creditMinor) !== 0n),
    );
    if (open) {
      findings.push({
        code: "other_noncurrent_review",
        severity: "notice",
        sourceLabel: open.sourceLabel ?? null,
        message: reviewNoncurrentMessage(open),
      });
    }
  }
  return findings;
}

function hasInvestingFinancingExchange(lines: readonly ClassifiedLine[]): boolean {
  if (cashDeltaOf(lines) === 0n) return false;
  let debit = false;
  let credit = false;
  for (const line of lines) {
    if (line.cashFlow !== "cfi" && line.cashFlow !== "cff" && line.cashFlow !== "distribution") {
      continue;
    }
    if (parseMinor(line.debitMinor) > 0n) debit = true;
    if (parseMinor(line.creditMinor) > 0n) credit = true;
  }
  return debit && credit;
}

function tradeReceivableDisposal(lines: readonly ClassifiedLine[]): boolean {
  if (cashDeltaOf(lines) !== 0n) return false;
  const sold = lines.some(
    (line) =>
      (line.accountCode === "fixed_assets" || line.accountCode === "intangible_assets") &&
      parseMinor(line.creditMinor) > 0n,
  );
  const trade = lines.some(
    (line) => line.accountCode === "accounts_receivable" && parseMinor(line.debitMinor) > 0n,
  );
  return sold && trade;
}

function isReviewNoncurrent(line: ClassifiedLine): boolean {
  return (
    line.cashFlow === "non_cash" &&
    (line.accountCode === "other_noncurrent_assets" ||
      line.accountCode === "other_noncurrent_liabilities")
  );
}

function reviewNoncurrentMessage(line: ClassifiedLine): string {
  if (line.accountCode === "other_noncurrent_liabilities" || line.report === "liability") {
    return "Other non-current liabilities are not a cash-flow account. Map the line to a borrowing or a long-term provision.";
  }
  return "Other non-current assets are not a cash-flow account. Map the line to a deposit or a loan given.";
}

function chargeCredits(
  lines: readonly ClassifiedLine[],
  journals: Map<string, ClassifiedLine[]>,
  accumCodes: readonly string[],
  expenseCodes: ReadonlySet<string>,
): bigint {
  const accum = new Set(accumCodes);
  let total = 0n;
  for (const line of lines) {
    if (!line.accountCode || !accum.has(line.accountCode) || line.journalId === undefined) continue;
    const credit = parseMinor(line.creditMinor);
    if (credit === 0n) continue;
    const journal = journals.get(line.journalId) ?? [];
    if (
      journal.some(
        (other) => other.accountCode !== undefined && expenseCodes.has(other.accountCode),
      )
    ) {
      total += credit;
    }
  }
  return total;
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function carriesCurrentYearOpening(fiscal: StatementFiscalYear | undefined): boolean {
  if (!fiscal) return false;
  if (!sameFiscalYear(fiscal.openingDate, fiscal.statementDate, fiscal)) return false;
  const start = fiscalYearStart(fiscal.openingDate, fiscal.yearEndMonth, fiscal.yearEndDay);
  const end = fiscalYearEnd(fiscal.openingDate, fiscal.yearEndMonth, fiscal.yearEndDay);
  if (fiscal.openingDate === start || fiscal.openingDate === end) return false;
  return fiscal.openingDate > start && fiscal.openingDate < end;
}

function sameFiscalYear(left: string, right: string, fiscal: StatementFiscalYear): boolean {
  return (
    fiscalEndingYear(left, fiscal.yearEndMonth, fiscal.yearEndDay) ===
    fiscalEndingYear(right, fiscal.yearEndMonth, fiscal.yearEndDay)
  );
}

function fiscalEndingYear(date: string, month: number, day: number): number {
  const [year, dateMonth, dateDay] = dateParts(date);
  const afterEnd = dateMonth > month || (dateMonth === month && dateDay > day);
  return afterEnd ? year + 1 : year;
}

function fiscalYearEnd(date: string, month: number, day: number): string {
  const endYear = fiscalEndingYear(date, month, day);
  return isoDate(endYear, month, day);
}

function fiscalYearStart(date: string, month: number, day: number): string {
  const end = fiscalYearEnd(date, month, day);
  const [year, endMonth, endDay] = dateParts(end);
  const start = new Date(Date.UTC(year - 1, endMonth - 1, endDay));
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString().slice(0, 10);
}

function dateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  return [year ?? 0, month ?? 0, day ?? 0];
}

function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

interface IncomeParts {
  revenue: bigint;
  expenses: bigint;
  tax: bigint;
}

function emptyIncome(): IncomeParts {
  return { revenue: 0n, expenses: 0n, tax: 0n };
}

function addIncome(bucket: IncomeParts, line: ClassifiedLine): void {
  const debit = parseMinor(line.debitMinor);
  const credit = parseMinor(line.creditMinor);
  if (line.report === "revenue") bucket.revenue += credit - debit;
  else if (line.report === "expense") {
    const amount = debit - credit;
    bucket.expenses += amount;
    if (line.accountCode === "tax_expense") bucket.tax += amount;
  }
}

function incomeEffect(line: ClassifiedLine): bigint {
  const debit = parseMinor(line.debitMinor);
  const credit = parseMinor(line.creditMinor);
  if (line.report === "revenue") return credit - debit;
  if (line.report === "expense") return -(debit - credit);
  return 0n;
}

function splitIncome(
  lines: readonly ClassifiedLine[],
  carryOpeningIncome: boolean,
  fiscal: StatementFiscalYear | undefined,
): {
  period: IncomeParts;
  before: IncomeParts;
  sameYear: IncomeParts;
  priorEarnings: bigint;
} {
  const period = emptyIncome();
  const before = emptyIncome();
  const sameYear = emptyIncome();
  let priorEarnings = 0n;
  for (const line of lines) {
    if (line.report !== "revenue" && line.report !== "expense") continue;
    if (line.journalKind === "opening") {
      if (carryOpeningIncome) addIncome(before, line);
      else priorEarnings += incomeEffect(line);
      continue;
    }
    if (line.period === "opening") {
      priorEarnings += incomeEffect(line);
      if (inCurrentFiscalYear(line, fiscal)) addIncome(sameYear, line);
      continue;
    }
    addIncome(period, line);
  }
  return { period, before, sameYear, priorEarnings };
}

function inCurrentFiscalYear(
  line: ClassifiedLine,
  fiscal: StatementFiscalYear | undefined,
): boolean {
  if (!fiscal || line.periodEnd === undefined) return false;
  return sameFiscalYear(line.periodEnd, fiscal.statementDate, fiscal);
}

function combineIncome(...parts: readonly IncomeParts[]): IncomeParts {
  const total = emptyIncome();
  for (const part of parts) {
    total.revenue += part.revenue;
    total.expenses += part.expenses;
    total.tax += part.tax;
  }
  return total;
}

function yearToDateResult(income: IncomeParts): StatementSet["yearToDate"] {
  const net = income.revenue - income.expenses;
  return {
    revenueMinor: income.revenue.toString(),
    expensesMinor: income.expenses.toString(),
    netIncomeMinor: net.toString(),
    profitBeforeTaxMinor: (net + income.tax).toString(),
    taxExpenseMinor: income.tax.toString(),
  };
}

function beforeNexoraResult(
  revenue: bigint,
  expenses: bigint,
  tax: bigint,
): StatementSet["beforeNexora"] {
  if (revenue === 0n && expenses === 0n) return null;
  const net = revenue - expenses;
  return {
    revenueMinor: revenue.toString(),
    expensesMinor: expenses.toString(),
    netIncomeMinor: net.toString(),
    profitBeforeTaxMinor: (net + tax).toString(),
    taxExpenseMinor: tax.toString(),
  };
}

function effectiveTaxResult(netIncome: bigint, tax: bigint): StatementSet["effectiveTax"] {
  const profitBeforeTax = netIncome + tax;
  return {
    profitBeforeTaxMinor: profitBeforeTax.toString(),
    taxExpenseMinor: tax.toString(),
    effectiveTaxRate: effectiveRate(tax, profitBeforeTax),
  };
}

function effectiveRate(tax: bigint, profitBeforeTax: bigint): string | null {
  if (profitBeforeTax === 0n) return null;
  return new Decimal(tax.toString())
    .div(new Decimal(profitBeforeTax.toString()))
    .toFixed(6, Decimal.ROUND_HALF_EVEN);
}

function nonCashItems(lines: readonly ClassifiedLine[]): StatementSet["nonCash"]["items"] {
  const items: {
    type: NonCashItemType;
    amountMinor: string;
    message: string;
  }[] = [];
  const movement = lines.filter(
    (line) => line.journalKind !== "opening" && line.period === "movement",
  );
  const deferred = closingDebit(movement, (line) => line.accountCode === "asset_sale_receivable");
  if (deferred > 0n) {
    items.push({
      type: "deferred_consideration",
      amountMinor: deferred.toString(),
      message: "PP&E disposed of for deferred consideration",
    });
  }
  const financed = financedAccounts(nonCashJournals(movement));
  const debt = netCredit(movement, financed.debt);
  if (debt > 0n) {
    items.push({
      type: "asset_acquired_with_debt",
      amountMinor: debt.toString(),
      message: "Assets acquired with debt",
    });
  }
  const capex = netCredit(movement, financed.capex);
  if (capex > 0n) {
    items.push({
      type: "capex_on_credit",
      amountMinor: capex.toString(),
      message: "Capital expenditure purchased on credit",
    });
  }
  return items;
}

function nonCashJournals(lines: readonly ClassifiedLine[]): ClassifiedLine[][] {
  const journals: ClassifiedLine[][] = [];
  for (const journal of groupJournals(lines).values()) {
    if (cashDeltaOf(journal) !== 0n) continue;
    journals.push(journal);
  }
  return journals;
}

function financedAccounts(journals: readonly (readonly ClassifiedLine[])[]): {
  debt: Set<string>;
  capex: Set<string>;
} {
  const debt = new Set<string>();
  const capex = new Set<string>();
  for (const journal of journals) {
    const bought = journal.some(
      (line) =>
        (line.accountCode === "fixed_assets" ||
          line.accountCode === "intangible_assets" ||
          line.accountCode === "capital_advances") &&
        parseMinor(line.debitMinor) > 0n,
    );
    if (!bought) continue;
    for (const line of journal) {
      if (parseMinor(line.creditMinor) === 0n) continue;
      if (line.accountCode === "capex_payables") capex.add(line.accountId);
      else if (line.report === "liability" && line.cashFlow === "cff") debt.add(line.accountId);
    }
  }
  return { debt, capex };
}

function netCredit(lines: readonly ClassifiedLine[], accounts: ReadonlySet<string>): bigint {
  let net = 0n;
  for (const line of lines) {
    if (!accounts.has(line.accountId)) continue;
    net += parseMinor(line.creditMinor) - parseMinor(line.debitMinor);
  }
  return net > 0n ? net : 0n;
}

function closingDebit(
  lines: readonly ClassifiedLine[],
  match: (line: ClassifiedLine) => boolean,
): bigint {
  let net = 0n;
  for (const line of lines) {
    if (!match(line)) continue;
    net += parseMinor(line.debitMinor) - parseMinor(line.creditMinor);
  }
  return net > 0n ? net : 0n;
}

function policyMaterial(policy: StatementPolicy | undefined): { policy?: StatementPolicy } {
  if (!policy?.leaseAccounting && !policy?.interestPaid) return {};
  return {
    policy: {
      ...(policy.leaseAccounting === undefined ? {} : { leaseAccounting: policy.leaseAccounting }),
      ...(policy.interestPaid === undefined ? {} : { interestPaid: policy.interestPaid }),
    },
  };
}
