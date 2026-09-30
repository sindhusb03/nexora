import { KernelError } from "./errors.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodStatus = "open" | "closed";

export function assertPeriodRange(startDate: string, endDate: string): void {
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || startDate > endDate) {
    throw new KernelError("FIN_INVALID_PERIOD", "Period dates must be ISO dates with start <= end");
  }
}

export function periodsOverlap(
  left: { readonly startDate: string; readonly endDate: string },
  right: { readonly startDate: string; readonly endDate: string },
): boolean {
  return left.startDate <= right.endDate && right.startDate <= left.endDate;
}

export function assertNoPeriodOverlap(
  candidate: { readonly startDate: string; readonly endDate: string },
  existing: readonly { readonly startDate: string; readonly endDate: string }[],
): void {
  assertPeriodRange(candidate.startDate, candidate.endDate);
  for (const period of existing) {
    if (periodsOverlap(candidate, period)) {
      throw new KernelError("FIN_OVERLAPPING_PERIOD", "Accounting periods cannot overlap");
    }
  }
}

/** Closed periods stay closed. Corrections are new journals in an open period. */
export function assertPeriodOpen(status: PeriodStatus): void {
  if (status !== "open") {
    throw new KernelError("FIN_PERIOD_CLOSED", "Posting is blocked because the period is closed");
  }
}

export function assertExpectedVersion(actual: number, expected: number | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new KernelError(
      "FIN_VERSION_CONFLICT",
      `Expected version ${expected} but found ${actual}`,
    );
  }
}
