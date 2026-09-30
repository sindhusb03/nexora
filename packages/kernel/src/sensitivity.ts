import { valueDcf, type DcfInput, type DcfResult } from "./dcf.js";
import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { ENGINE_VERSION } from "./version.js";

export interface DcfShock {
  readonly id: string;
  readonly wacc?: string | undefined;
  readonly terminalGrowth?: string | undefined;
}

/**
 * One kernel run per declared shock. The base input object is not mutated.
 */
export function valueDcfSensitivity(input: {
  readonly base: DcfInput;
  readonly shocks: readonly DcfShock[];
}): {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly runs: readonly { readonly id: string; readonly result: DcfResult }[];
} {
  if (input.shocks.length === 0) {
    throw new KernelError("VALUATION_INVALID_ASSUMPTION", "Sensitivity requires at least one shock");
  }
  const seen = new Set<string>();
  const runs = input.shocks.map((shock) => {
    if (shock.id.length === 0 || seen.has(shock.id)) {
      throw new KernelError("VALUATION_INVALID_ASSUMPTION", "Sensitivity shock ids must be unique");
    }
    seen.add(shock.id);
    const next: DcfInput = {
      ...input.base,
      ...(shock.wacc !== undefined ? { wacc: shock.wacc } : {}),
      ...(shock.terminalGrowth !== undefined ? { terminalGrowth: shock.terminalGrowth } : {}),
    };
    return { id: shock.id, result: valueDcf(next) };
  });
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
    runs,
  };
}
