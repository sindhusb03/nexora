import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { assertCurrency, parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export type ReportClass = "asset" | "liability" | "equity" | "revenue" | "expense";
export type CashFlowClass = "cash" | "cfo" | "cfi" | "cff" | "non_cash" | "distribution";

export interface ClassifiedLine {
  readonly accountId: string;
  readonly report: ReportClass;
  readonly cashFlow: CashFlowClass;
  readonly debitMinor: string;
  readonly creditMinor: string;
  readonly currency: string;
  /** Opening lines are posted activity from earlier periods. They are not rewritten. */
  readonly period: "opening" | "movement";
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
    readonly endingMinor: string;
    readonly close: "derived";
  };
}

interface AccountPosition {
  report: ReportClass;
  cashFlow: CashFlowClass;
  opening: bigint;
  movementDebit: bigint;
  movementCredit: bigint;
}

/**
 * Derives the three statements and the retained-earnings roll-forward.
 * The income close into retained earnings is a presentation derivation.
 * Source lines are not mutated.
 *
 * Debit-positive convention: closing = opening + debit - credit.
 * Cash flow is the direct method: each non-cash movement's opposite side is cash.
 */
export function buildStatements(input: {
  readonly currency: string;
  readonly retainedEarningsAccountId: string;
  readonly lines: readonly ClassifiedLine[];
}): StatementSet {
  const currency = assertCurrency(input.currency);
  if (input.retainedEarningsAccountId.length === 0) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Retained earnings account is required");
  }

  const accounts = new Map<string, AccountPosition>();

  for (const line of input.lines) {
    if (line.currency !== currency) {
      throw new KernelError("FIN_CURRENCY_MISMATCH", "Statements require a single currency");
    }
    const debit = parseMinor(line.debitMinor);
    const credit = parseMinor(line.creditMinor);
    if (debit < 0n || credit < 0n) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Statement lines cannot be negative");
    }

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
    if (line.period === "opening") {
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
  let assets = 0n;
  let liabilities = 0n;
  let otherEquity = 0n;
  let beginningCash = 0n;
  let endingCash = 0n;
  let cfo = 0n;
  let cfi = 0n;
  let cff = 0n;
  let distributions = 0n;

  for (const [accountId, position] of accounts) {
    const closing = position.opening + position.movementDebit - position.movementCredit;
    balanceCheck += closing;

    if (position.report === "revenue") {
      revenue += -closing;
    } else if (position.report === "expense") {
      expenses += closing;
    } else if (position.report === "asset") {
      assets += closing;
    } else if (position.report === "liability") {
      liabilities += -closing;
    } else if (accountId === input.retainedEarningsAccountId) {
      // Folded into the derived retained-earnings close below.
    } else if (position.cashFlow === "distribution") {
      distributions += position.opening + position.movementDebit - position.movementCredit;
    } else if (position.report === "equity") {
      otherEquity += -closing;
    }

    if (position.cashFlow === "cash") {
      beginningCash += position.opening;
      endingCash += closing;
    }

    if (position.cashFlow === "cfo") {
      cfo += position.movementCredit - position.movementDebit;
    } else if (position.cashFlow === "cfi") {
      cfi += position.movementCredit - position.movementDebit;
    } else if (position.cashFlow === "cff" || position.cashFlow === "distribution") {
      cff += position.movementCredit - position.movementDebit;
    }
  }

  if (balanceCheck !== 0n) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      "Classified lines are not in balance",
    );
  }

  const netIncome = revenue - expenses;
  const openingRetained = retained ? -retained.opening : 0n;
  const endingRetained = openingRetained + netIncome - distributions;
  const equity = otherEquity + endingRetained;

  if (assets !== liabilities + equity) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      "Balance sheet does not satisfy assets = liabilities + equity",
    );
  }
  if (beginningCash + cfo + cfi + cff !== endingCash) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      "Cash flow does not roll forward to ending cash",
    );
  }

  const statement: StatementSet = {
    engineVersion: ENGINE_VERSION,
    currency,
    inputHash: hashMaterial({
      currency,
      retainedEarningsAccountId: input.retainedEarningsAccountId,
      lines: input.lines.map((line) => ({
        accountId: line.accountId,
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
      cfoMinor: cfo.toString(),
      cfiMinor: cfi.toString(),
      cffMinor: cff.toString(),
      endingCashMinor: endingCash.toString(),
    },
    retainedEarnings: {
      openingMinor: openingRetained.toString(),
      netIncomeMinor: netIncome.toString(),
      distributionsMinor: distributions.toString(),
      endingMinor: endingRetained.toString(),
      close: "derived",
    },
  };

  return statement;
}
