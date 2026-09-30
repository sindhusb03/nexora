import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { assertCurrency, parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export interface CashWeekInput {
  readonly weekIndex: string;
  readonly label: string;
  readonly inflowMinor: string;
  readonly outflowMinor: string;
}

export interface CashWeekResult {
  readonly weekIndex: string;
  readonly label: string;
  readonly beginningMinor: string;
  readonly inflowMinor: string;
  readonly outflowMinor: string;
  readonly endingMinor: string;
  readonly headroomMinor: string;
  readonly belowMinimum: boolean;
}

export interface CashForecast {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly currency: string;
  readonly openingCashMinor: string;
  readonly minimumCashMinor: string;
  readonly weeks: readonly CashWeekResult[];
  readonly alerts: readonly {
    readonly weekIndex: string;
    readonly endingMinor: string;
    readonly shortfallMinor: string;
  }[];
}

/** Thirteen weekly buckets. Ending cash of week n is the opening cash of week n+1. */
export function buildCashForecast(input: {
  readonly currency: string;
  readonly openingCashMinor: string;
  readonly minimumCashMinor: string;
  readonly weeks: readonly CashWeekInput[];
}): CashForecast {
  const currency = assertCurrency(input.currency);
  if (input.weeks.length !== 13) {
    throw new KernelError("FIN_INVALID_PERIOD", "13-week cash requires exactly 13 weeks");
  }
  const minimum = parseMinor(input.minimumCashMinor);
  let beginning = parseMinor(input.openingCashMinor);
  const weeks: CashWeekResult[] = [];
  const alerts: { weekIndex: string; endingMinor: string; shortfallMinor: string }[] = [];
  input.weeks.forEach((week, index) => {
    const expected = String(index + 1);
    if (week.weekIndex !== expected) {
      throw new KernelError("FIN_INVALID_PERIOD", `Week ${expected} is missing or out of order`);
    }
    const inflow = parseMinor(week.inflowMinor);
    const outflow = parseMinor(week.outflowMinor);
    if (inflow < 0n || outflow < 0n) {
      throw new KernelError("FIN_AMOUNT_SCALE", "Weekly cash movements cannot be negative");
    }
    const ending = beginning + inflow - outflow;
    const headroom = ending - minimum;
    const belowMinimum = headroom < 0n;
    if (belowMinimum) {
      alerts.push({
        weekIndex: week.weekIndex,
        endingMinor: ending.toString(),
        shortfallMinor: (-headroom).toString(),
      });
    }
    weeks.push({
      weekIndex: week.weekIndex,
      label: week.label,
      beginningMinor: beginning.toString(),
      inflowMinor: inflow.toString(),
      outflowMinor: outflow.toString(),
      endingMinor: ending.toString(),
      headroomMinor: headroom.toString(),
      belowMinimum,
    });
    beginning = ending;
  });
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({
      currency,
      openingCashMinor: input.openingCashMinor,
      minimumCashMinor: input.minimumCashMinor,
      weeks: input.weeks.map((week) => ({
        weekIndex: week.weekIndex,
        label: week.label,
        inflowMinor: week.inflowMinor,
        outflowMinor: week.outflowMinor,
      })),
    }),
    currency,
    openingCashMinor: input.openingCashMinor,
    minimumCashMinor: input.minimumCashMinor,
    weeks,
    alerts,
  };
}
