import {
  KernelError,
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

export function netDebitPositiveBalances(
  journals: readonly {
    readonly lines: readonly {
      readonly accountId: string;
      readonly debitMinor: string;
      readonly creditMinor: string;
    }[];
  }[],
  reportByAccount: ReadonlyMap<string, ReportClass>,
): TrialBalanceLine[] {
  const nets = new Map<string, bigint>();
  for (const journal of journals) {
    for (const line of journal.lines) {
      const net = BigInt(line.debitMinor) - BigInt(line.creditMinor);
      nets.set(line.accountId, (nets.get(line.accountId) ?? 0n) + net);
    }
  }

  const lines: TrialBalanceLine[] = [];
  for (const accountId of [...nets.keys()].sort()) {
    const net = nets.get(accountId) ?? 0n;
    if (net === 0n) {
      continue;
    }
    const report = reportByAccount.get(accountId);
    if (!report) {
      throw new KernelError("FIN_NOT_FOUND", "Posted line references an unknown account");
    }
    lines.push({
      accountId,
      rateType: rateTypeForReport(report),
      debitPositiveMinor: net.toString(),
    });
  }
  return lines;
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
