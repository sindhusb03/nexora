import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export interface DebitPositiveBalance {
  readonly accountId: string;
  readonly debitPositiveMinor: string;
}

export interface EliminationLine {
  readonly accountId: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
  readonly evidenceId: string;
}

export interface EliminationResult {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly balances: readonly DebitPositiveBalance[];
}

/**
 * Intercompany elimination identity.
 * Ownership, NCI, and currency translation are separate explicit steps.
 * This function only accepts amounts already expressed in one group currency.
 * Eliminations must balance, and the group trial balance must still balance.
 */
export function eliminateIntercompany(input: {
  readonly balances: readonly DebitPositiveBalance[];
  readonly eliminations: readonly EliminationLine[];
}): EliminationResult {
  let eliminationDebit = 0n;
  let eliminationCredit = 0n;
  const adjustments = new Map<string, bigint>();

  for (const line of input.eliminations) {
    if (line.evidenceId.length === 0) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Elimination requires evidence");
    }
    const debit = parseMinor(line.debitMinor);
    const credit = parseMinor(line.creditMinor);
    if (
      debit < 0n ||
      credit < 0n ||
      (debit > 0n && credit > 0n) ||
      (debit === 0n && credit === 0n)
    ) {
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Elimination line is not one-sided");
    }
    eliminationDebit += debit;
    eliminationCredit += credit;
    adjustments.set(line.accountId, (adjustments.get(line.accountId) ?? 0n) + debit - credit);
  }

  if (eliminationDebit !== eliminationCredit) {
    throw new KernelError("FIN_UNBALANCED_JOURNAL", "Intercompany elimination does not balance");
  }

  const combined = new Map<string, bigint>();
  for (const balance of input.balances) {
    combined.set(
      balance.accountId,
      (combined.get(balance.accountId) ?? 0n) + parseMinor(balance.debitPositiveMinor),
    );
  }
  for (const [accountId, adjustment] of adjustments) {
    combined.set(accountId, (combined.get(accountId) ?? 0n) + adjustment);
  }

  let total = 0n;
  const balances: DebitPositiveBalance[] = [];
  for (const accountId of [...combined.keys()].sort()) {
    const minor = combined.get(accountId) ?? 0n;
    total += minor;
    balances.push({ accountId, debitPositiveMinor: minor.toString() });
  }

  if (total !== 0n) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Consolidated trial balance does not balance");
  }

  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
    balances,
  };
}
