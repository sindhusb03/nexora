import type { PostedActivityLine } from "@nexora/db";
import { KernelError, type ClassifiedLine } from "@nexora/kernel";

/**
 * Stored form of journalKind "opening". Written only when the post asks for
 * an opening journal. A source reference the caller typed is never enough.
 */
const OPENING_PREFIX = "opening:";

export function journalKindFromSource(sourceRef: string | null | undefined): "opening" | undefined {
  if (sourceRef?.startsWith(OPENING_PREFIX)) return "opening";
  return undefined;
}

export function displaySourceRef(sourceRef: string | null): string | null {
  if (!sourceRef?.startsWith(OPENING_PREFIX)) return sourceRef;
  const label = sourceRef.slice(OPENING_PREFIX.length);
  return label.length > 0 ? label : null;
}

export function openingSourceRef(label: string | null | undefined): string {
  const text = label?.replace(/^opening:/, "").trim();
  return `${OPENING_PREFIX}${text && text.length > 0 ? text : "Opening trial balance"}`;
}

/**
 * One classifier for the statements API and the workspace snapshot.
 * Journal lines do not store a per-line label, so sourceLabel is omitted.
 */
export function classifyPostedActivity(
  activity: readonly PostedActivityLine[],
  period: { readonly periodId: string; readonly startDate: string },
): ClassifiedLine[] {
  const lines: ClassifiedLine[] = [];
  for (const line of activity) {
    if (line.periodId !== period.periodId && !(line.periodEnd < period.startDate)) {
      throw new KernelError(
        "FIN_OVERLAPPING_PERIOD",
        "Posted activity falls outside the statement period",
      );
    }
    const journalKind = journalKindFromSource(line.sourceRef);
    lines.push({
      journalId: line.journalId,
      accountId: line.accountId,
      accountCode: line.accountCode,
      report: line.report,
      cashFlow: line.cashFlow,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency: line.currency,
      period: line.periodId === period.periodId ? "movement" : "opening",
      ...(journalKind === undefined ? {} : { journalKind }),
    });
  }
  lines.sort((left, right) => {
    const periodOrder = left.period.localeCompare(right.period);
    return (
      periodOrder ||
      left.accountId.localeCompare(right.accountId) ||
      (left.journalId ?? "").localeCompare(right.journalId ?? "") ||
      left.debitMinor.localeCompare(right.debitMinor) ||
      left.creditMinor.localeCompare(right.creditMinor)
    );
  });
  return lines;
}
