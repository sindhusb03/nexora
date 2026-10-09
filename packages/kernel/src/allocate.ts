import { KernelError } from "./errors.js";
import { AnalyticalDecimal, parseMinor } from "./money.js";

const PLAIN_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Largest-remainder allocation. Each share is rounded half-even, then ±1 minor
 * units are assigned so the parts sum exactly to the total. Ties go to the
 * lower index. A negative total allocates the absolute value and restores the sign.
 */
export function allocateExact(totalMinor: string, weights: readonly string[]): string[] {
  const total = parseMinor(totalMinor);
  if (weights.length === 0) {
    throw new KernelError("CALC_FAILED", "Allocation requires at least one weight");
  }
  const parsed = weights.map((weight, index) => {
    if (!PLAIN_DECIMAL.test(weight)) {
      throw new KernelError("CALC_FAILED", `Weight ${index} must be a non-negative decimal`);
    }
    return new AnalyticalDecimal(weight);
  });
  const sumWeights = parsed.reduce((sum, weight) => sum.add(weight), new AnalyticalDecimal(0));
  if (sumWeights.lte(0)) {
    throw new KernelError("CALC_FAILED", "Allocation weights must sum to more than zero");
  }

  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const base = new AnalyticalDecimal(magnitude.toString());
  const exact = parsed.map((weight) => base.mul(weight).div(sumWeights));
  const rounded = exact.map((share) => BigInt(share.toDecimalPlaces(0).toFixed(0)));
  let diff = magnitude - rounded.reduce((sum, part) => sum + part, 0n);
  const remainder = exact.map((share, index) => ({
    index,
    gap: share.sub(share.toDecimalPlaces(0)),
  }));

  if (diff > 0n) {
    const order = [...remainder].sort((left, right) =>
      compareGap(right.gap, left.gap, left.index, right.index),
    );
    let cursor = 0;
    while (diff > 0n) {
      const slot = order[cursor % order.length];
      if (!slot) break;
      rounded[slot.index] = (rounded[slot.index] ?? 0n) + 1n;
      diff -= 1n;
      cursor += 1;
    }
  } else if (diff < 0n) {
    const order = [...remainder].sort((left, right) =>
      compareGap(left.gap, right.gap, left.index, right.index),
    );
    let cursor = 0;
    while (diff < 0n) {
      const slot = order[cursor % order.length];
      if (!slot) break;
      rounded[slot.index] = (rounded[slot.index] ?? 0n) - 1n;
      diff += 1n;
      cursor += 1;
    }
  }

  return rounded.map((part) => (negative ? -part : part).toString());
}

/**
 * Half-even split of one amount across S&M, R&D and G&A. Shares must total 1.
 * Remainder units follow the fixed order S&M, then R&D, then G&A.
 */
export function allocateSplit(
  amountMinor: string,
  split: { readonly sm: string; readonly rnd: string; readonly ga: string },
): { sm: string; rnd: string; ga: string } {
  const shares = [split.sm, split.rnd, split.ga].map((share) => {
    if (!PLAIN_DECIMAL.test(share)) {
      throw new KernelError("CALC_FAILED", "Split shares must be non-negative decimals");
    }
    return new AnalyticalDecimal(share);
  });
  const total = shares.reduce((sum, share) => sum.add(share), new AnalyticalDecimal(0));
  if (!total.eq(1)) {
    throw new KernelError("CALC_FAILED", "split_not_100");
  }
  const [sm, rnd, ga] = allocateExact(amountMinor, [split.sm, split.rnd, split.ga]);
  return { sm: sm ?? "0", rnd: rnd ?? "0", ga: ga ?? "0" };
}

function compareGap(
  leftGap: InstanceType<typeof AnalyticalDecimal>,
  rightGap: InstanceType<typeof AnalyticalDecimal>,
  leftIndex: number,
  rightIndex: number,
): number {
  if (!leftGap.eq(rightGap)) return leftGap.comparedTo(rightGap);
  return leftIndex - rightIndex;
}
