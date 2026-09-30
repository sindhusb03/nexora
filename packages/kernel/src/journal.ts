import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { assertCurrency, assertNonNegativeMinor, money, parseMinor, type Money } from "./money.js";
import { MAX_JOURNAL_LINES } from "./version.js";

export interface JournalLineInput {
  readonly accountId: string;
  readonly debit: Money;
  readonly credit: Money;
}

export interface JournalLine {
  readonly accountId: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
  readonly currency: string;
}

export interface BalancedJournal {
  readonly currency: string;
  readonly lines: readonly JournalLine[];
  readonly totalDebitMinor: string;
  readonly totalCreditMinor: string;
  readonly payloadHash: string;
}

export function validateJournal(input: {
  readonly currency: string;
  readonly lines: readonly JournalLineInput[];
  readonly entityId: string;
  readonly periodId: string;
}): BalancedJournal {
  const currency = assertCurrency(input.currency);
  if (input.lines.length < 2) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "A journal needs at least two lines");
  }
  if (input.lines.length > MAX_JOURNAL_LINES) {
    throw new KernelError("FIN_LIMIT_EXCEEDED", "Journal exceeds the line limit");
  }
  if (input.entityId.length === 0 || input.periodId.length === 0) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Entity and period are required");
  }

  let debit = 0n;
  let credit = 0n;
  const lines: JournalLine[] = [];

  for (const line of input.lines) {
    if (line.accountId.length === 0) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Account is required on every line");
    }
    if (line.debit.currency !== currency || line.credit.currency !== currency) {
      throw new KernelError("FIN_CURRENCY_MISMATCH", "Every line must use the journal currency");
    }
    const debitMinor = assertNonNegativeMinor(line.debit.minor, "Debit");
    const creditMinor = assertNonNegativeMinor(line.credit.minor, "Credit");
    if (debitMinor > 0n && creditMinor > 0n) {
      throw new KernelError(
        "FIN_INVALID_JOURNAL_LINE",
        "A line cannot carry both a debit and a credit",
      );
    }
    if (debitMinor === 0n && creditMinor === 0n) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "A line cannot be zero on both sides");
    }
    debit += debitMinor;
    credit += creditMinor;
    lines.push({
      accountId: line.accountId,
      debitMinor: debitMinor.toString(),
      creditMinor: creditMinor.toString(),
      currency,
    });
  }

  if (debit !== credit) {
    throw new KernelError(
      "FIN_UNBALANCED_JOURNAL",
      `Debits ${debit.toString()} do not equal credits ${credit.toString()}`,
    );
  }

  const normalized = lines.map((line) => ({
    accountId: line.accountId,
    debitMinor: line.debitMinor,
    creditMinor: line.creditMinor,
  }));

  return {
    currency,
    lines,
    totalDebitMinor: debit.toString(),
    totalCreditMinor: credit.toString(),
    payloadHash: hashMaterial({
      currency,
      entityId: input.entityId,
      periodId: input.periodId,
      lines: normalized,
    }),
  };
}

/** A reversal is a new journal. It does not mutate the posted original. */
export function buildReversalLines(lines: readonly JournalLine[]): JournalLine[] {
  if (lines.length < 2) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Cannot reverse an empty journal");
  }
  return lines.map((line) => ({
    accountId: line.accountId,
    debitMinor: line.creditMinor,
    creditMinor: line.debitMinor,
    currency: line.currency,
  }));
}

export function netLinesToZero(
  original: readonly JournalLine[],
  reversal: readonly JournalLine[],
): boolean {
  const nets = new Map<string, bigint>();
  for (const line of [...original, ...reversal]) {
    const current = nets.get(line.accountId) ?? 0n;
    nets.set(line.accountId, current + parseMinor(line.debitMinor) - parseMinor(line.creditMinor));
  }
  for (const net of nets.values()) {
    if (net !== 0n) {
      return false;
    }
  }
  return true;
}

export function lineToMoneyPair(line: JournalLine): { debit: Money; credit: Money } {
  return {
    debit: money(line.currency, line.debitMinor),
    credit: money(line.currency, line.creditMinor),
  };
}
