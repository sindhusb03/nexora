import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { assertCurrency, parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export type ReportClass = "asset" | "liability" | "equity" | "revenue" | "expense";
export type CashFlowClass = "cash" | "cfo" | "cfi" | "cff" | "non_cash" | "distribution";
export type LeaseAccounting = "ifrs16" | "asc842_finance" | "asc842_operating";
export type StatementIssueCode =
  "depreciation_split_needed" | "lease_additions_needed" | "disposal_gain_unmapped";

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
    readonly netIncomeMinor: string;
    readonly distributionsMinor: string;
    readonly directEntriesMinor: string;
    readonly endingMinor: string;
    readonly close: "derived";
  };
  readonly nonCash: {
    readonly leaseAdditionsMinor: string;
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

const ACCUM_CODES = [
  "accumulated_depreciation",
  "accumulated_amortisation",
  "rou_accumulated_depreciation",
] as const;

const GROSS_CODES = ["fixed_assets", "intangible_assets", "rou_assets"] as const;

/**
 * Derives the three statements and the retained-earnings roll-forward.
 * The income close into retained earnings is a presentation derivation.
 * Source lines are not mutated. The income statement is the movement period.
 * Opening revenue and expense roll into retained earnings; they are not current income.
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
  let revenue = 0n;
  let expenses = 0n;
  let priorEarnings = 0n;
  let assets = 0n;
  let liabilities = 0n;
  let otherEquity = 0n;
  let beginningCash = 0n;
  let endingCash = 0n;
  let distributions = 0n;
  const movementLines = input.lines.filter((line) => linePeriod(line) === "movement");
  const journalCashFlow = movementLines.every((line) => line.journalId !== undefined);
  const flows: Flows = { cfo: 0n, cfi: 0n, cff: 0n };

  for (const [accountId, position] of accounts) {
    const closing = position.opening + position.movementDebit - position.movementCredit;
    balanceCheck += closing;

    if (position.report === "revenue") {
      revenue += position.movementCredit - position.movementDebit;
      priorEarnings -= position.opening;
    } else if (position.report === "expense") {
      expenses += position.movementDebit - position.movementCredit;
      priorEarnings -= position.opening;
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
  applyDeferredTax(flows, movementLines);
  const lease = leaseAdditions(moves, movementLines);
  const findings = collectFindings(movementLines, journals, moves, lease.error);

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
    input.policy?.leaseAccounting ?? "ifrs16",
    movementLines,
  );
  reclassifyInvestingCollections(flows, input.lines, journals);
  if (balanceCheck !== 0n) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Classified lines are not in balance");
  }

  const netIncome = revenue - expenses;
  const directEntries = retained ? retained.movementCredit - retained.movementDebit : 0n;
  const openingRetained = (retained ? -retained.opening : 0n) + priorEarnings;
  const endingRetained = openingRetained + netIncome - distributions + directEntries;
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
      blocked ? "depreciation_split_needed" : "Cash flow does not roll forward",
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
      lines: input.lines.map((line) => ({
        ...(line.journalId === undefined ? {} : { journalId: line.journalId }),
        accountId: line.accountId,
        ...(line.accountCode === undefined ? {} : { accountCode: line.accountCode }),
        ...(line.journalKind === undefined ? {} : { journalKind: line.journalKind }),
        ...(line.sourceLabel === undefined ? {} : { sourceLabel: line.sourceLabel }),
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
      netIncomeMinor: netIncome.toString(),
      distributionsMinor: distributions.toString(),
      directEntriesMinor: directEntries.toString(),
      endingMinor: endingRetained.toString(),
      close: "derived",
    },
    nonCash: { leaseAdditionsMinor: lease.additions.toString() },
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
  if (
    lines.some(
      (line) =>
        (line.accountCode === "deferred_tax_asset" ||
          line.accountCode === "deferred_tax_liability") &&
        effect(line) !== 0n,
    )
  ) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Deferred tax is never cash-settled");
  }

  let otherNonCash = 0n;
  for (const line of lines) {
    if (line.cashFlow === "cash" || isSpecial(line) || isDa(line)) continue;
    if (line.cashFlow === "non_cash") {
      otherNonCash += effect(line);
      continue;
    }
    addFlow(flows, sectionFor(line, policy), effect(line));
  }
  if (otherNonCash !== 0n) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      `Journal ${journalId}: Cash classification needed`,
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
  flows.cfi += residual(lines, journals, "accumulated_depreciation", [
    "depreciation_ppe",
    "depreciation",
    "impairment",
  ]);
  flows.cfi += residual(lines, journals, "accumulated_amortisation", [
    "amortisation",
    "depreciation",
    "impairment",
  ]);
  for (const line of lines) {
    if (line.accountCode !== "gain_loss_on_disposal") continue;
    if (line.journalId !== undefined) {
      const journal = journals.get(line.journalId);
      if (journal && isCreditDisposal(journal)) continue;
    }
    flows.cfi += effect(line);
  }
  flows.cfi -= impairmentCredits(lines, journals, "fixed_assets", legacy);
  flows.cfi -= impairmentCredits(lines, journals, "intangible_assets", legacy);
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

/** Receivable created by a non-cash sale of a fixed or intangible asset. */
function isCreditDisposal(lines: readonly ClassifiedLine[]): boolean {
  if (cashDeltaOf(lines) !== 0n) return false;
  const sold = lines.some(
    (line) =>
      (line.accountCode === "fixed_assets" || line.accountCode === "intangible_assets") &&
      parseMinor(line.creditMinor) > 0n,
  );
  const receivable = lines.some(
    (line) =>
      line.report === "asset" && line.cashFlow === "cfo" && parseMinor(line.debitMinor) > 0n,
  );
  return sold && receivable;
}

/**
 * Proceeds of a credit sale are investing when the receivable is collected,
 * not when the non-cash sale is recorded.
 */
function reclassifyInvestingCollections(
  flows: Flows,
  lines: readonly ClassifiedLine[],
  movementJournals: Map<string, ClassifiedLine[]>,
): void {
  const pool = new Map<string, bigint>();
  for (const journal of groupJournals(lines).values()) {
    if (!isCreditDisposal(journal)) continue;
    for (const line of journal) {
      if (line.report !== "asset" || line.cashFlow !== "cfo") continue;
      const debit = parseMinor(line.debitMinor);
      if (debit <= 0n) continue;
      pool.set(line.accountId, (pool.get(line.accountId) ?? 0n) + debit);
    }
  }
  if (pool.size === 0) return;
  for (const line of lines) {
    if (linePeriod(line) !== "opening" || line.report !== "asset" || line.cashFlow !== "cfo") {
      continue;
    }
    const credit = parseMinor(line.creditMinor);
    const open = pool.get(line.accountId) ?? 0n;
    if (credit <= 0n || open <= 0n) continue;
    pool.set(line.accountId, open > credit ? open - credit : 0n);
  }
  for (const journal of movementJournals.values()) {
    if (cashDeltaOf(journal) === 0n) continue;
    for (const line of journal) {
      if (line.report !== "asset" || line.cashFlow !== "cfo") continue;
      const credit = parseMinor(line.creditMinor);
      const open = pool.get(line.accountId) ?? 0n;
      if (credit <= 0n || open <= 0n) continue;
      const take = open < credit ? open : credit;
      pool.set(line.accountId, open - take);
      flows.cfo -= take;
      flows.cfi += take;
    }
  }
}

function applyDeferredTax(flows: Flows, lines: readonly ClassifiedLine[]): void {
  for (const line of lines) {
    if (
      line.accountCode === "deferred_tax_asset" ||
      line.accountCode === "deferred_tax_liability"
    ) {
      flows.cfo += effect(line);
    }
  }
}

function leaseAdditions(
  moves: Map<string, Move>,
  lines: readonly ClassifiedLine[],
): { additions: bigint; error: boolean } {
  const rou = moveOf(moves, "rou_assets");
  const accum = moveOf(moves, "rou_accumulated_depreciation");
  const current = moveOf(moves, "lease_liabilities_current");
  const noncurrent = moveOf(moves, "lease_liabilities_noncurrent");
  const rouMoved = rou.debit !== 0n || rou.credit !== 0n;
  const liabMoved = current.debit + current.credit + noncurrent.debit + noncurrent.credit !== 0n;
  if (!rouMoved && !liabMoved) return { additions: 0n, error: false };

  const grossMapped =
    lines.some((line) => line.accountCode === "rou_assets") &&
    lines.some((line) => line.accountCode === "rou_accumulated_depreciation");
  const depRou = expenseNet(moves, "depreciation_rou");
  const combined = expenseNet(moves, "depreciation");
  const inseparable = combined !== 0n && depRou === 0n;
  if (!lines.some((line) => line.accountCode === "rou_assets")) {
    return { additions: 0n, error: true };
  }
  if (grossMapped) {
    const accumDelta = accum.credit - accum.debit;
    const grossDelta = rou.debit - rou.credit;
    if (accumDelta < 0n && inseparable) return { additions: 0n, error: true };
    if (accumDelta < 0n) return { additions: grossDelta + (depRou - accumDelta), error: false };
    return { additions: grossDelta, error: false };
  }
  if (inseparable) return { additions: 0n, error: true };
  const addBack = depRou > 0n ? depRou : rou.credit;
  return { additions: rou.debit - rou.credit + addBack, error: false };
}

function applyLeaseCash(
  flows: Flows,
  moves: Map<string, Move>,
  additions: bigint,
  leaseAccounting: LeaseAccounting,
  lines: readonly ClassifiedLine[],
): void {
  if (
    additions === 0n &&
    !lines.some((line) => line.accountCode?.startsWith("lease_liabilities"))
  ) {
    return;
  }
  const current = moveOf(moves, "lease_liabilities_current");
  const noncurrent = moveOf(moves, "lease_liabilities_noncurrent");
  const delta = current.credit - current.debit + (noncurrent.credit - noncurrent.debit);
  const portion = delta - additions;
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
      "Depreciation & amortisation";
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
  return findings;
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

function policyMaterial(policy: StatementPolicy | undefined): { policy?: StatementPolicy } {
  if (!policy?.leaseAccounting && !policy?.interestPaid) return {};
  return {
    policy: {
      ...(policy.leaseAccounting === undefined ? {} : { leaseAccounting: policy.leaseAccounting }),
      ...(policy.interestPaid === undefined ? {} : { interestPaid: policy.interestPaid }),
    },
  };
}
