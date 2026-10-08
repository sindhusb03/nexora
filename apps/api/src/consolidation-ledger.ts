import {
  KernelError,
  type ClassifiedLine,
  type RateType,
  type ReportClass,
  type TrialBalanceLine,
} from "@nexora/kernel";

/**
 * Current-rate method. The ledger account's report class selects the rate.
 * Assets and liabilities use closing, equity uses historical, and income uses average.
 */
export const CONSOLIDATION_RATE_POLICY = "current-rate-by-report-class-v1";

export function rateTypeForReport(report: ReportClass): RateType {
  switch (report) {
    case "asset":
    case "liability":
      return "closing";
    case "equity":
      return "historical";
    case "revenue":
    case "expense":
      return "average";
    default: {
      const unknown: never = report;
      throw new KernelError("FIN_INVALID_JOURNAL_LINE", `Unknown report class ${String(unknown)}`);
    }
  }
}

/**
 * Trial balance for translation. Uses the statements' opening and movement split:
 * balance-sheet accounts keep their closing balance, income is current-period movement,
 * and prior-period income is added to retained earnings (equity, historical rate).
 */
export function trialBalanceFromClassifiedLines(
  lines: readonly ClassifiedLine[],
  retainedEarningsAccountId: string,
): TrialBalanceLine[] {
  const positions = new Map<string, { report: ReportClass; opening: bigint; movement: bigint }>();
  for (const line of lines) {
    const delta = BigInt(line.debitMinor) - BigInt(line.creditMinor);
    const existing = positions.get(line.accountId);
    if (existing && existing.report !== line.report) {
      throw new KernelError(
        "FIN_STATEMENT_IMBALANCE",
        `Account ${line.accountId} has conflicting classification`,
      );
    }
    const position = existing ?? { report: line.report, opening: 0n, movement: 0n };
    if (line.period === "opening") {
      position.opening += delta;
    } else {
      position.movement += delta;
    }
    positions.set(line.accountId, position);
  }

  let priorEarnings = 0n;
  const balances = new Map<string, { report: ReportClass; amount: bigint }>();
  for (const [accountId, position] of positions) {
    if (position.report === "revenue" || position.report === "expense") {
      priorEarnings += position.opening;
      if (position.movement !== 0n) {
        balances.set(accountId, { report: position.report, amount: position.movement });
      }
      continue;
    }
    const closing = position.opening + position.movement;
    if (closing !== 0n) {
      balances.set(accountId, { report: position.report, amount: closing });
    }
  }
  if (priorEarnings !== 0n) {
    const retained = balances.get(retainedEarningsAccountId);
    const amount = (retained?.amount ?? 0n) + priorEarnings;
    if (amount === 0n) {
      balances.delete(retainedEarningsAccountId);
    } else {
      balances.set(retainedEarningsAccountId, { report: "equity", amount });
    }
  }

  return [...balances.keys()].sort().map((accountId) => {
    const balance = balances.get(accountId);
    if (!balance) {
      throw new KernelError("FIN_STATEMENT_IMBALANCE", "Trial balance line missing");
    }
    return {
      accountId,
      rateType: rateTypeForReport(balance.report),
      debitPositiveMinor: balance.amount.toString(),
    };
  });
}

export function consolidateTranslations(
  parts: readonly {
    readonly ctaMinor: string;
    readonly lines: readonly { readonly accountId: string; readonly debitPositiveMinor: string }[];
  }[],
): {
  readonly ctaMinor: string;
  readonly lines: { readonly accountId: string; readonly debitPositiveMinor: string }[];
} {
  const combined = new Map<string, bigint>();
  let cta = 0n;
  for (const part of parts) {
    cta += BigInt(part.ctaMinor);
    for (const line of part.lines) {
      combined.set(
        line.accountId,
        (combined.get(line.accountId) ?? 0n) + BigInt(line.debitPositiveMinor),
      );
    }
  }
  const lines = [...combined.keys()].sort().map((accountId) => ({
    accountId,
    debitPositiveMinor: (combined.get(accountId) ?? 0n).toString(),
  }));
  return { ctaMinor: cta.toString(), lines };
}

/** True when a consolidation request still tries to supply a trial balance. */
export function requestSuppliesTrialBalance(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  if ("lines" in record || "balances" in record || "sourceCurrency" in record) {
    return true;
  }
  return containsKey(record, "debitPositiveMinor");
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsKey(entry, key));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (key in record) {
    return true;
  }
  return Object.values(record).some((entry) => containsKey(entry, key));
}
