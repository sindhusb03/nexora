import { buildCashForecast, type CashForecast } from "./cash-weeks.js";
import { forecastDrivers, type ForecastResult } from "./forecast.js";
import { hashMaterial } from "./hash.js";
import {
  canonicalAccount,
  isExpenseAccount,
  isReviewCashFlowPlaceholder,
  isRevenueAccount,
} from "./ingestion-chart.js";
import type { ReportClass } from "./statements.js";
import {
  INGESTION_FORMULA_VERSION,
  type IngestionAmount,
  type IngestionBank,
  type IngestionCheckInput,
} from "./ingestion-types.js";
import { AnalyticalDecimal, parseMinor } from "./money.js";
import { buildStatements, type ClassifiedLine, type StatementSet } from "./statements.js";

export interface ModelJournalLine {
  readonly accountCode: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
}

export interface ModelJournal {
  readonly kind: "opening" | "movement";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly lines: readonly ModelJournalLine[];
}

export interface LinkedModel {
  readonly formulaVersion: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly journals: readonly ModelJournal[];
  readonly statements: StatementSet;
  readonly forecast: ForecastResult;
  readonly cashForecast: CashForecast;
}

export type LinkedModelResult =
  | { readonly ok: true; readonly model: LinkedModel }
  | { readonly ok: false; readonly message: string };

/**
 * Builds posting journals whose derived statements match the mapped package.
 * The earliest balance sheet is an opening snapshot, including a credit to
 * retained earnings, posted in that period. Later periods post balance-sheet
 * movements except retained earnings, plus the income statement. The kernel
 * derives ending retained earnings. Forecast and 13-week cash are kernel
 * outputs from those same mapped lines. They are not a second ledger.
 *
 * When gross margin falls outside 0..1, the forecast uses margin 0 and operating
 * expenses equal to total expenses for the latest income period.
 */
export function buildLinkedModel(input: IngestionCheckInput): LinkedModelResult {
  const periods = closingPeriods(input.amounts);
  if (periods.length < 2) {
    return {
      ok: false,
      message: "A linked model needs an opening balance sheet and a later balance sheet",
    };
  }
  const first = periods[0];
  if (!first) {
    return { ok: false, message: "Opening balance sheet period is missing" };
  }
  const posted = input.postedBalances ?? {};
  for (const period of periods) {
    const current = snapshot(input.amounts, period);
    const equation = balanceEquation(current);
    if (equation.assets !== equation.liabilities + equation.equity) {
      return {
        ok: false,
        message: `Balance sheet at ${period} does not balance (${equation.assets.toString()} vs ${(equation.liabilities + equation.equity).toString()})`,
      };
    }
    const sourceTotal = assetSourceTotal(input.amounts, period);
    if (sourceTotal !== null && sourceTotal !== equation.assets) {
      return {
        ok: false,
        message: `Balance sheet total at ${period} does not match the source total`,
      };
    }
    const prior = posted[period];
    if (!prior) continue;
    const compared = comparePosted(current, prior);
    if (compared === "double") {
      return {
        ok: false,
        message: `Balance sheet at ${period} would double the posted ledger`,
      };
    }
    if (compared === "mismatch") {
      return {
        ok: false,
        message: `Balance sheet at ${period} does not match the posted ledger`,
      };
    }
  }
  const cashMessage = cashTies(input, periods);
  if (cashMessage) return { ok: false, message: cashMessage };

  const journals: ModelJournal[] = [];
  if (!posted[first]) {
    const balances = snapshot(input.amounts, first);
    const openingIncome = incomeFor(input.amounts, first);
    if (openingIncome.length > 0 && !input.fiscalYearEnd) {
      return {
        ok: false,
        message:
          "Your company has no year-end set, so these opening figures can't be placed. Set your year-end in company settings, then confirm this upload again.",
      };
    }
    const atYearEnd =
      input.fiscalYearEnd &&
      Number(first.slice(5, 7)) === input.fiscalYearEnd.month &&
      Number(first.slice(8, 10)) === input.fiscalYearEnd.day;
    const income = atYearEnd ? [] : openingIncome;
    const netIncome = income.reduce(
      (sum, amount) =>
        sum +
        (isRevenueAccount(amount.accountCode)
          ? parseMinor(amount.minor)
          : -parseMinor(amount.minor)),
      0n,
    );
    if (income.length > 0) {
      balances.set("retained_earnings", (balances.get("retained_earnings") ?? 0n) - netIncome);
    }
    const openingLines = [
      ...snapshotLines(balances),
      ...movementLines(new Map(), new Map(), income),
    ];
    if (openingLines.length < 2) {
      return { ok: false, message: "Opening snapshot does not have a balanced journal" };
    }
    journals.push({
      kind: "opening",
      periodStart: first,
      periodEnd: first,
      lines: openingLines,
    });
  }
  let previous = snapshot(input.amounts, first);
  for (let index = 1; index < periods.length; index += 1) {
    const period = periods[index];
    if (!period) continue;
    const current = snapshot(input.amounts, period);
    if (posted[period]) {
      previous = current;
      continue;
    }
    const lines = movementLines(previous, current, incomeFor(input.amounts, period));
    const debit = side(lines, "debit");
    const credit = side(lines, "credit");
    if (debit !== credit || lines.length < 2) {
      return {
        ok: false,
        message: `Movement at ${period} does not balance (${debit.toString()} vs ${credit.toString()})`,
      };
    }
    journals.push({
      kind: "movement",
      periodStart: periodStart(input.amounts, period),
      periodEnd: period,
      lines,
    });
    previous = current;
  }

  if (
    journals.some((journal) =>
      journal.lines.some((line) => isReviewCashFlowPlaceholder(line.accountCode)),
    )
  ) {
    return {
      ok: false,
      message:
        "Map other non-current accounts to a deposit, a loan given, a borrowing, or a long-term provision before a projection can be built.",
    };
  }

  const classified = classifiedLines(journals, input.currency);
  let statements: StatementSet;
  try {
    statements = buildStatements({
      currency: input.currency,
      retainedEarningsAccountId: "retained_earnings",
      lines: classified,
      ...(input.fiscalYearEnd
        ? {
            fiscalYear: {
              openingDate: first,
              statementDate: periods[periods.length - 1] ?? first,
              yearEndMonth: input.fiscalYearEnd.month,
              yearEndDay: input.fiscalYearEnd.day,
            },
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Statement derivation failed";
    return { ok: false, message };
  }

  const forecast = buildForecast(input.amounts, periods);
  const cashForecast = buildCash(input, statements.cashFlow.endingCashMinor, periods);
  const inputHash = hashMaterial(hashableInput(input));
  const outputHash = hashMaterial({
    formulaVersion: INGESTION_FORMULA_VERSION,
    journals: journals.map((journal) => ({
      kind: journal.kind,
      periodStart: journal.periodStart,
      periodEnd: journal.periodEnd,
      lines: journal.lines.map((line) => ({
        accountCode: line.accountCode,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      })),
    })),
    statementHash: statements.inputHash,
    forecastHash: forecast.inputHash,
    cashHash: cashForecast.inputHash,
  });
  return {
    ok: true,
    model: {
      formulaVersion: INGESTION_FORMULA_VERSION,
      inputHash,
      outputHash,
      journals,
      statements,
      forecast,
      cashForecast,
    },
  };
}

function closingPeriods(amounts: readonly IngestionAmount[]): string[] {
  return [
    ...new Set(
      amounts
        .filter(
          (amount) =>
            amount.statement === "balance_sheet" &&
            amount.role === "line" &&
            amount.balanceKind === "closing" &&
            amount.accountCode &&
            canonicalAccount(amount.accountCode),
        )
        .map((amount) => amount.periodEnd),
    ),
  ].sort();
}

function snapshot(amounts: readonly IngestionAmount[], period: string): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const amount of amounts) {
    if (
      amount.statement !== "balance_sheet" ||
      amount.role !== "line" ||
      amount.balanceKind !== "closing" ||
      amount.periodEnd !== period ||
      !amount.accountCode ||
      !canonicalAccount(amount.accountCode)
    ) {
      continue;
    }
    map.set(amount.accountCode, (map.get(amount.accountCode) ?? 0n) + parseMinor(amount.minor));
  }
  return map;
}

function snapshotLines(balances: ReadonlyMap<string, bigint>): ModelJournalLine[] {
  const lines: ModelJournalLine[] = [];
  for (const code of [...balances.keys()].sort()) {
    const minor = balances.get(code) ?? 0n;
    const line = signedLine(code, minor, true);
    if (line) lines.push(line);
  }
  return lines;
}

function movementLines(
  previous: ReadonlyMap<string, bigint>,
  current: ReadonlyMap<string, bigint>,
  income: readonly IngestionAmount[],
): ModelJournalLine[] {
  const codes = new Set([...previous.keys(), ...current.keys()]);
  const lines: ModelJournalLine[] = [];
  for (const code of [...codes].sort()) {
    if (code === "retained_earnings") continue;
    const delta = (current.get(code) ?? 0n) - (previous.get(code) ?? 0n);
    const line = signedLine(code, delta, true);
    if (line) lines.push(line);
  }
  const incomeTotals = new Map<string, bigint>();
  for (const amount of income) {
    if (!amount.accountCode || !canonicalAccount(amount.accountCode)) continue;
    incomeTotals.set(
      amount.accountCode,
      (incomeTotals.get(amount.accountCode) ?? 0n) + parseMinor(amount.minor),
    );
  }
  for (const code of [...incomeTotals.keys()].sort()) {
    const minor = incomeTotals.get(code) ?? 0n;
    const line = signedLine(code, minor, false);
    if (line) lines.push(line);
  }
  return lines.filter((line) => line.debitMinor !== "0" || line.creditMinor !== "0");
}

function signedLine(code: string, minor: bigint, balanceSheet: boolean): ModelJournalLine | null {
  if (minor === 0n) return null;
  const account = canonicalAccount(code);
  if (!account) return null;
  const naturalDebit = balanceSheet
    ? account.report === "asset" || account.code === "distributions"
    : account.report === "expense";
  const debit = naturalDebit ? minor > 0n : minor < 0n;
  const absMinor = minor < 0n ? -minor : minor;
  return {
    accountCode: code,
    debitMinor: debit ? absMinor.toString() : "0",
    creditMinor: debit ? "0" : absMinor.toString(),
  };
}

function incomeFor(amounts: readonly IngestionAmount[], period: string): IngestionAmount[] {
  return amounts.filter(
    (amount) =>
      amount.statement === "income_statement" &&
      amount.role === "line" &&
      amount.periodEnd === period &&
      (isRevenueAccount(amount.accountCode) || isExpenseAccount(amount.accountCode)),
  );
}

function classifiedLines(journals: readonly ModelJournal[], currency: string): ClassifiedLine[] {
  const last = journals.length - 1;
  const lines: ClassifiedLine[] = [];
  journals.forEach((journal, index) => {
    const period = index === last ? "movement" : "opening";
    for (const line of journal.lines) {
      const account = canonicalAccount(line.accountCode);
      if (!account) continue;
      lines.push({
        accountId: line.accountCode,
        report: account.report,
        cashFlow: account.cashFlow,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency,
        period,
        periodEnd: journal.periodEnd,
        ...(journal.kind === "opening" ? { journalKind: "opening" as const } : {}),
      });
    }
  });
  return lines;
}

function buildForecast(
  amounts: readonly IngestionAmount[],
  periods: readonly string[],
): ForecastResult {
  const last = periods[periods.length - 1] ?? "";
  const prior = periods.length >= 2 ? (periods[periods.length - 2] ?? null) : null;
  const revenue = sumReport(amounts, last, "revenue");
  const cogs = sumCode(amounts, last, "cogs");
  const opex = sumCode(amounts, last, "operating_expenses");
  const expenses = sumReport(amounts, last, "expense");
  let margin = "0";
  let opexMinor = opex < 0n ? (-opex).toString() : opex.toString();
  if (revenue > 0n) {
    const computed = new AnalyticalDecimal((revenue - cogs).toString()).div(revenue.toString());
    if (computed.gte(0) && computed.lte(1)) {
      margin = computed.toFixed(12);
    } else {
      opexMinor = (expenses < 0n ? -expenses : expenses).toString();
    }
  }
  let growth = "0";
  if (prior) {
    const priorRevenue = sumReport(amounts, prior, "revenue");
    if (priorRevenue > 0n) {
      growth = new AnalyticalDecimal(revenue.toString())
        .div(priorRevenue.toString())
        .minus(1)
        .toFixed(12);
    }
  }
  return forecastDrivers({
    revenueMinor: revenue.toString(),
    growthRate: growth,
    grossMargin: margin,
    opexMinor,
    periods: 12,
  });
}

function buildCash(
  input: IngestionCheckInput,
  openingCashMinor: string,
  periods: readonly string[],
): CashForecast {
  const end = periods[periods.length - 1] ?? "1970-01-01";
  const weeks = emptyWeeks();
  for (const bank of input.banks) {
    for (const transaction of bank.transactions) {
      const index = weekIndex(transaction.date, end);
      const week = weeks[index];
      if (!week) continue;
      const minor = parseMinor(transaction.minor);
      if (minor >= 0n) week.inflow += minor;
      else week.outflow += -minor;
    }
  }
  return buildCashForecast({
    currency: input.currency,
    openingCashMinor,
    minimumCashMinor: "0",
    weeks: weeks.map((week, index) => ({
      weekIndex: String(index + 1),
      label: `Week ${index + 1}`,
      inflowMinor: week.inflow.toString(),
      outflowMinor: week.outflow.toString(),
    })),
  });
}

function emptyWeeks(): { inflow: bigint; outflow: bigint }[] {
  return Array.from({ length: 13 }, () => ({ inflow: 0n, outflow: 0n }));
}

function weekIndex(date: string, periodEnd: string): number {
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  const current = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(end) || Number.isNaN(current)) return 12;
  const daysBefore = Math.floor((end - current) / 86_400_000);
  if (daysBefore <= 0) return 12;
  const bucket = 12 - Math.floor(daysBefore / 7);
  if (bucket < 0) return 0;
  return bucket;
}

function sumReport(
  amounts: readonly IngestionAmount[],
  period: string,
  report: "revenue" | "expense",
): bigint {
  let total = 0n;
  for (const amount of incomeFor(amounts, period)) {
    const account = amount.accountCode ? canonicalAccount(amount.accountCode) : null;
    if (account?.report !== report) continue;
    total += parseMinor(amount.minor);
  }
  return total;
}

function sumCode(amounts: readonly IngestionAmount[], period: string, code: string): bigint {
  return incomeFor(amounts, period)
    .filter((amount) => amount.accountCode === code)
    .reduce((sum, amount) => sum + parseMinor(amount.minor), 0n);
}

function periodStart(amounts: readonly IngestionAmount[], periodEnd: string): string {
  const found =
    amounts.find(
      (amount) =>
        amount.statement === "income_statement" &&
        amount.periodEnd === periodEnd &&
        amount.periodStart,
    ) ?? amounts.find((amount) => amount.periodEnd === periodEnd && amount.periodStart);
  return found?.periodStart ?? periodEnd;
}

function side(lines: readonly ModelJournalLine[], which: "debit" | "credit"): bigint {
  return lines.reduce(
    (sum, line) => sum + parseMinor(which === "debit" ? line.debitMinor : line.creditMinor),
    0n,
  );
}

function balanceEquation(balances: ReadonlyMap<string, bigint>): {
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
} {
  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  for (const [code, minor] of balances) {
    const account = canonicalAccount(code);
    if (account?.report === "asset") assets += minor;
    else if (account?.report === "liability") liabilities += minor;
    else if (account?.report === "equity") equity += minor;
  }
  return { assets, liabilities, equity };
}

function assetSourceTotal(amounts: readonly IngestionAmount[], period: string): bigint | null {
  const total = amounts.find(
    (amount) =>
      amount.statement === "balance_sheet" &&
      amount.periodEnd === period &&
      amount.accountCode === "total_assets" &&
      (amount.role === "total" || amount.role === "subtotal"),
  );
  return total ? parseMinor(total.minor) : null;
}

function comparePosted(
  source: ReadonlyMap<string, bigint>,
  posted: Readonly<Record<string, string>>,
): "ok" | "double" | "mismatch" {
  const codes = new Set<string>([...source.keys(), ...Object.keys(posted)]);
  let equal = true;
  let doubled = true;
  let material = false;
  for (const code of codes) {
    const account = canonicalAccount(code);
    if (!account) continue;
    if (
      account.report !== "asset" &&
      account.report !== "liability" &&
      account.report !== "equity"
    ) {
      continue;
    }
    const left = source.get(code) ?? 0n;
    const right = parseMinor(posted[code] ?? "0");
    if (left !== 0n || right !== 0n) material = true;
    if (left !== right) equal = false;
    if (left !== right * 2n) doubled = false;
  }
  if (equal) return "ok";
  if (material && doubled) return "double";
  return "mismatch";
}

function cashTies(input: IngestionCheckInput, periods: readonly string[]): string | null {
  const last = periods[periods.length - 1];
  if (!last) return null;
  const banks = input.banks.filter((bank) => bank.periodEnd === last);
  if (banks.length === 0) return null;
  let bankCash = 0n;
  for (const bank of banks) bankCash += parseMinor(bank.closingMinor);
  const book = snapshot(input.amounts, last).get("cash") ?? 0n;
  const tolerance = parseMinor(input.toleranceMinor);
  const diff = book > bankCash ? book - bankCash : bankCash - book;
  if (diff > tolerance) return `Cash at ${last} does not tie to the bank`;
  return null;
}

export interface LedgerBalanceSource {
  readonly periods: readonly { readonly periodId: string; readonly endDate: string }[];
  readonly accounts: readonly {
    readonly accountId: string;
    readonly code: string;
    readonly report: ReportClass;
    readonly retainedEarnings: boolean;
  }[];
  readonly journals: readonly {
    readonly periodId: string;
    readonly lines: readonly {
      readonly accountId: string;
      readonly debitMinor: string;
      readonly creditMinor: string;
    }[];
  }[];
}

/** Cumulative signed balances by period end. Retained earnings includes net income. */
export function cumulativeLedgerBalances(
  source: LedgerBalanceSource,
): Record<string, Record<string, string>> {
  const ends = source.periods.map((period) => ({
    periodId: period.periodId,
    endDate: period.endDate.slice(0, 10),
  }));
  const byId = new Map(source.accounts.map((account) => [account.accountId, account]));
  const result: Record<string, Record<string, string>> = {};
  for (const end of ends) {
    const totals = new Map<string, bigint>();
    for (const journal of source.journals) {
      const journalEnd = ends.find((period) => period.periodId === journal.periodId)?.endDate;
      if (!journalEnd || journalEnd > end.endDate) continue;
      for (const line of journal.lines) {
        const account = byId.get(line.accountId);
        if (!account) continue;
        const code = account.retainedEarnings ? "retained_earnings" : account.code;
        const minor = signedBalance(
          account.report,
          code,
          parseMinor(line.debitMinor),
          parseMinor(line.creditMinor),
        );
        totals.set(code, (totals.get(code) ?? 0n) + minor);
      }
    }
    let income = 0n;
    let distributions = 0n;
    for (const [code, minor] of totals) {
      const account = canonicalAccount(code);
      if (account?.report === "revenue") income += minor;
      else if (account?.report === "expense") income -= minor;
      else if (code === "distributions") distributions += minor;
    }
    if (totals.has("retained_earnings") || income !== 0n || distributions !== 0n) {
      totals.set(
        "retained_earnings",
        (totals.get("retained_earnings") ?? 0n) + income - distributions,
      );
    }
    const row: Record<string, string> = {};
    for (const [code, minor] of totals) {
      if (!canonicalAccount(code)) continue;
      if (
        canonicalAccount(code)?.report === "revenue" ||
        canonicalAccount(code)?.report === "expense"
      ) {
        continue;
      }
      row[code] = minor.toString();
    }
    result[end.endDate] = row;
  }
  return result;
}

function signedBalance(report: ReportClass, code: string, debit: bigint, credit: bigint): bigint {
  const naturalDebit = report === "asset" || report === "expense" || code === "distributions";
  return naturalDebit ? debit - credit : credit - debit;
}

function hashableInput(input: IngestionCheckInput): unknown {
  return {
    currency: input.currency,
    fiscalYearEnd: input.fiscalYearEnd
      ? { month: String(input.fiscalYearEnd.month), day: String(input.fiscalYearEnd.day) }
      : null,
    toleranceMinor: input.toleranceMinor,
    postedBalances: Object.entries(input.postedBalances ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([period, accounts]) => ({
        period,
        accounts: Object.entries(accounts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, minor]) => ({ code, minor })),
      })),
    amounts: [...input.amounts]
      .sort((left, right) => left.valueId.localeCompare(right.valueId))
      .map((amount) => ({
        valueId: amount.valueId,
        accountCode: amount.accountCode,
        minor: amount.minor,
        periodEnd: amount.periodEnd,
        statement: amount.statement,
        role: amount.role,
        scale: amount.scale,
        currency: amount.currency,
        spanMonths: String(amount.spanMonths),
      })),
    banks: input.banks.map((bank: IngestionBank) => ({
      documentId: bank.documentId,
      openingMinor: bank.openingMinor,
      closingMinor: bank.closingMinor,
      transactions: bank.transactions.map((transaction) => ({
        valueId: transaction.valueId,
        minor: transaction.minor,
        date: transaction.date,
      })),
    })),
  };
}
