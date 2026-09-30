import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal } from "./money.js";
import { ANALYTICAL_SCALE, ENGINE_VERSION } from "./version.js";

export type VarianceKind = "revenue" | "expense" | "profit";

export interface VarianceLineInput {
  readonly key: string;
  readonly label: string;
  readonly kind: VarianceKind;
  readonly actualMinor: string;
  readonly planMinor: string;
}

export interface VarianceLine {
  readonly key: string;
  readonly label: string;
  readonly kind: VarianceKind;
  readonly actualMinor: string;
  readonly planMinor: string;
  readonly varianceMinor: string;
  readonly varianceRatio: string | null;
  readonly favorable: boolean;
}

export interface VarianceResult {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly lines: readonly VarianceLine[];
}

/** Actual minus plan. Revenue and profit are favorable when actual is higher. Expense is favorable when actual is lower. */
export function explainVariance(input: { readonly lines: readonly VarianceLineInput[] }): VarianceResult {
  const lines = input.lines.map((line) => {
    const actual = minor(line.actualMinor, line.key);
    const plan = minor(line.planMinor, line.key);
    const variance = actual.minus(plan);
    const favorable = line.kind === "expense" ? variance.lte(0) : variance.gte(0);
    const ratio = plan.isZero() ? null : variance.div(plan).toFixed(ANALYTICAL_SCALE);
    return {
      key: line.key,
      label: line.label,
      kind: line.kind,
      actualMinor: actual.toFixed(0),
      planMinor: plan.toFixed(0),
      varianceMinor: variance.toFixed(0),
      varianceRatio: ratio,
      favorable,
    };
  });
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
    lines,
  };
}

function minor(value: string, label: string): InstanceType<typeof AnalyticalDecimal> {
  if (!/^-?\d+$/.test(value)) {
    throw new KernelError("FIN_AMOUNT_SCALE", `${label} must be integer minor units`);
  }
  return new AnalyticalDecimal(value);
}
