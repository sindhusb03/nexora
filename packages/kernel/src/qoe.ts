import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal } from "./money.js";
import { ANALYTICAL_SCALE, ENGINE_VERSION } from "./version.js";

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

export interface QoeAdjustment {
  readonly adjustmentId: string;
  readonly sourceRowId: string;
  readonly actorId: string;
  readonly amount: string;
}

export interface QoeBridge {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly reported: string;
  readonly adjustmentsTotal: string;
  readonly normalized: string;
  readonly steps: readonly {
    readonly adjustmentId: string;
    readonly sourceRowId: string;
    readonly actorId: string;
    readonly amount: string;
    readonly stepHash: string;
  }[];
}

/**
 * Reported → explicit adjustments → normalized.
 * Adjustments never replace the reported figure.
 */
export function buildQoeBridge(input: {
  readonly reported: string;
  readonly adjustments: readonly QoeAdjustment[];
}): QoeBridge {
  const reported = decimal(input.reported, "reported");
  let total = new AnalyticalDecimal(0);
  const steps = input.adjustments.map((adjustment) => {
    if (
      adjustment.adjustmentId.length === 0 ||
      adjustment.sourceRowId.length === 0 ||
      adjustment.actorId.length === 0
    ) {
      throw new KernelError("FIN_NOT_FOUND", "QoE adjustment requires a source row and an actor");
    }
    const amount = decimal(adjustment.amount, adjustment.adjustmentId);
    total = total.plus(amount);
    return {
      adjustmentId: adjustment.adjustmentId,
      sourceRowId: adjustment.sourceRowId,
      actorId: adjustment.actorId,
      amount: amount.toFixed(ANALYTICAL_SCALE),
      stepHash: hashMaterial(adjustment),
    };
  });
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial(input),
    reported: reported.toFixed(ANALYTICAL_SCALE),
    adjustmentsTotal: total.toFixed(ANALYTICAL_SCALE),
    normalized: reported.plus(total).toFixed(ANALYTICAL_SCALE),
    steps,
  };
}

function decimal(value: string, label: string): InstanceType<typeof AnalyticalDecimal> {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new KernelError("FIN_AMOUNT_SCALE", `${label} must be a decimal string`);
  }
  return new AnalyticalDecimal(value);
}
