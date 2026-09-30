import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal, parseMinor } from "./money.js";
import { ANALYTICAL_SCALE, ENGINE_VERSION } from "./version.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface OwnershipEdge {
  readonly parentEntityId: string;
  readonly childEntityId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly percent: string;
}

export function resolveOwnership(input: {
  readonly asOf: string;
  readonly parentEntityId: string;
  readonly childEntityId: string;
  readonly edges: readonly OwnershipEdge[];
}): { readonly percent: string; readonly engineVersion: string; readonly inputHash: string } {
  if (!DATE.test(input.asOf)) {
    throw new KernelError("FIN_INVALID_PERIOD", "Ownership as-of date is invalid");
  }
  const matches = input.edges.filter(
    (edge) =>
      edge.parentEntityId === input.parentEntityId && edge.childEntityId === input.childEntityId,
  );
  const active = matches.filter((edge) => covers(edge, input.asOf));
  active.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
  const chosen = active[0];
  if (chosen && active[1] && active[1].effectiveFrom === chosen.effectiveFrom) {
    throw new KernelError("FIN_OVERLAPPING_PERIOD", "Overlapping ownership edges");
  }
  const percent = chosen ? assertPercent(chosen.percent) : "0.000000000000";
  return {
    percent,
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
  };
}

/**
 * Split subsidiary equity into the parent's share and NCI.
 * The two parts add back to the subsidiary equity minor units exactly.
 */
export function attributeNonControllingInterest(input: {
  readonly subsidiaryEquityMinor: string;
  readonly ownershipPercent: string;
}): {
  readonly parentEquityMinor: string;
  readonly nciMinor: string;
  readonly engineVersion: string;
  readonly inputHash: string;
} {
  const equity = parseMinor(input.subsidiaryEquityMinor);
  const percent = new AnalyticalDecimal(assertPercent(input.ownershipPercent));
  const parent = BigInt(
    new AnalyticalDecimal(equity.toString())
      .mul(percent)
      .toDecimalPlaces(0, AnalyticalDecimal.ROUND_HALF_EVEN)
      .toFixed(0),
  );
  return {
    parentEquityMinor: parent.toString(),
    nciMinor: (equity - parent).toString(),
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
  };
}

function covers(edge: OwnershipEdge, asOf: string): boolean {
  if (
    !DATE.test(edge.effectiveFrom) ||
    (edge.effectiveTo !== null && !DATE.test(edge.effectiveTo))
  ) {
    throw new KernelError("FIN_INVALID_PERIOD", "Ownership effective dates are invalid");
  }
  if (edge.effectiveTo !== null && edge.effectiveTo < edge.effectiveFrom) {
    throw new KernelError("FIN_INVALID_PERIOD", "Ownership effective range is invalid");
  }
  return edge.effectiveFrom <= asOf && (edge.effectiveTo === null || asOf <= edge.effectiveTo);
}

function assertPercent(value: string): string {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new KernelError("VALUATION_INVALID_ASSUMPTION", "Ownership percent must be a decimal");
  }
  const percent = new AnalyticalDecimal(value);
  if (percent.lt(0) || percent.gt(1)) {
    throw new KernelError(
      "VALUATION_INVALID_ASSUMPTION",
      "Ownership percent must be between 0 and 1",
    );
  }
  return percent.toFixed(ANALYTICAL_SCALE);
}
