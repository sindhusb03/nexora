import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal, assertNonNegativeMinor, parseMinor } from "./money.js";
import { ANALYTICAL_SCALE, ENGINE_VERSION } from "./version.js";

const PLAIN_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface DebtRoll {
  readonly openingMinor: string;
  readonly drawMinor: string;
  readonly repaymentMinor: string;
  readonly accruedInterestMinor: string;
  readonly closingMinor: string;
  readonly engineVersion: string;
  readonly inputHash: string;
}

/** opening + draws − repayments + accrued interest = closing. */
export function rollDebt(input: {
  readonly openingMinor: string;
  readonly drawMinor: string;
  readonly repaymentMinor: string;
  readonly accruedInterestMinor: string;
}): DebtRoll {
  const opening = assertNonNegativeMinor(input.openingMinor, "Opening debt");
  const draw = assertNonNegativeMinor(input.drawMinor, "Debt draw");
  const repayment = assertNonNegativeMinor(input.repaymentMinor, "Debt repayment");
  const interest = assertNonNegativeMinor(input.accruedInterestMinor, "Accrued interest");
  const closing = opening + draw + interest - repayment;
  if (closing < 0n) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", "Debt closing cannot be negative");
  }
  return {
    openingMinor: opening.toString(),
    drawMinor: draw.toString(),
    repaymentMinor: repayment.toString(),
    accruedInterestMinor: interest.toString(),
    closingMinor: closing.toString(),
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
  };
}

export interface CapTableHolding {
  readonly holderId: string;
  readonly commonShares: string;
  readonly options: string;
  readonly convertibles: string;
}

export function reconcileCapTable(holdings: readonly CapTableHolding[]): {
  readonly fullyDilutedShares: string;
  readonly ownership: readonly {
    readonly holderId: string;
    readonly fullyDilutedShares: string;
    readonly percent: string;
  }[];
  readonly engineVersion: string;
  readonly inputHash: string;
} {
  if (holdings.length === 0) {
    throw new KernelError("CALC_INVALID_NODE", "Cap table is empty");
  }
  const rows = holdings.map((holding) => {
    const common = assertNonNegativeMinor(holding.commonShares, "Common shares");
    const options = assertNonNegativeMinor(holding.options, "Options");
    const convertibles = assertNonNegativeMinor(holding.convertibles, "Convertibles");
    return { holderId: holding.holderId, fullyDiluted: common + options + convertibles };
  });
  const total = rows.reduce((sum, row) => sum + row.fullyDiluted, 0n);
  if (total === 0n) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Cap table has no shares");
  }

  let assigned = new AnalyticalDecimal(0);
  const one = new AnalyticalDecimal(1);
  const ownership = rows.map((row, index) => {
    const percent =
      index === rows.length - 1
        ? one.minus(assigned)
        : new AnalyticalDecimal(row.fullyDiluted.toString()).div(
            new AnalyticalDecimal(total.toString()),
          );
    const fixed = percent.toFixed(ANALYTICAL_SCALE);
    if (index !== rows.length - 1) {
      assigned = assigned.plus(new AnalyticalDecimal(fixed));
    }
    return {
      holderId: row.holderId,
      fullyDilutedShares: row.fullyDiluted.toString(),
      percent: fixed,
    };
  });

  return {
    fullyDilutedShares: total.toString(),
    ownership,
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(holdings),
  };
}

export interface SourcesUsesLine {
  readonly label: string;
  readonly amountMinor: string;
}

/** Sources equal uses. Amounts stay integer minor units. */
export function assertSourcesEqualUses(input: {
  readonly sources: readonly SourcesUsesLine[];
  readonly uses: readonly SourcesUsesLine[];
}): {
  readonly totalSourcesMinor: string;
  readonly totalUsesMinor: string;
  readonly engineVersion: string;
  readonly inputHash: string;
} {
  const totalSources = sumLines(input.sources, "Source");
  const totalUses = sumLines(input.uses, "Use");
  if (totalSources !== totalUses) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Sources do not equal uses");
  }
  return {
    totalSourcesMinor: totalSources.toString(),
    totalUsesMinor: totalUses.toString(),
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
  };
}

/** Closed-form return for one entry outflow and one exit inflow. */
export function lboReturns(input: {
  readonly entryEquity: string;
  readonly exitEquity: string;
  readonly holdYears: string;
}): {
  readonly moic: string;
  readonly irr: string;
  readonly engineVersion: string;
  readonly inputHash: string;
} {
  if (
    !PLAIN_DECIMAL.test(input.entryEquity) ||
    !PLAIN_DECIMAL.test(input.exitEquity) ||
    !PLAIN_DECIMAL.test(input.holdYears)
  ) {
    throw new KernelError("VALUATION_INVALID_ASSUMPTION", "LBO returns require decimal strings");
  }
  const entry = new AnalyticalDecimal(input.entryEquity);
  const exit = new AnalyticalDecimal(input.exitEquity);
  const years = new AnalyticalDecimal(input.holdYears);
  if (entry.lte(0) || exit.lt(0) || years.lte(0)) {
    throw new KernelError(
      "VALUATION_INVALID_ASSUMPTION",
      "LBO entry equity and hold period must be positive",
    );
  }
  const moic = exit.div(entry);
  const irr = moic.pow(new AnalyticalDecimal(1).div(years)).minus(1);
  return {
    moic: moic.toFixed(ANALYTICAL_SCALE),
    irr: irr.toFixed(ANALYTICAL_SCALE),
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
  };
}

function sumLines(lines: readonly SourcesUsesLine[], label: string): bigint {
  if (lines.length === 0) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", `${label} list is empty`);
  }
  return lines.reduce(
    (sum, line) => sum + parseMinor(assertNonNegativeMinor(line.amountMinor, label).toString()),
    0n,
  );
}
