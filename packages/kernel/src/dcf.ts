import type Decimal from "decimal.js";

import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal, assertCurrency } from "./money.js";
import { ANALYTICAL_SCALE, ENGINE_VERSION } from "./version.js";

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

export interface DcfInput {
  readonly currency: string;
  /** Explicit forecast free cash flows for t = 1..n. Plain decimal strings. */
  readonly freeCashFlows: readonly string[];
  /** Annual discount rate, for example "0.10". */
  readonly wacc: string;
  /** Perpetual growth rate. Must be strictly less than WACC. */
  readonly terminalGrowth: string;
  readonly netDebt: string;
  readonly nonOperatingAssets: string;
  readonly otherClaims: string;
}

export interface DcfResult {
  readonly engineVersion: string;
  readonly currency: string;
  readonly convention: "year_end_gordon_growth";
  readonly terminalCashFlowPolicy: "gordon_from_last_explicit";
  readonly inputHash: string;
  readonly terminalFreeCashFlow: string;
  readonly terminalValue: string;
  readonly enterpriseValue: string;
  readonly equityValue: string;
  readonly presentValues: readonly string[];
  readonly presentValueOfTerminalValue: string;
}

/**
 * Enterprise value uses year-end discounting:
 *   EV = Σ FCF_t / (1+WACC)^t + TV / (1+WACC)^n
 *   TV = FCF_(n+1) / (WACC-g)
 *   FCF_(n+1) = FCF_n * (1+g)
 * Equity value = EV - net debt + non-operating assets - other claims.
 * The caller cannot supply enterprise value or equity value.
 */
export function valueDcf(input: DcfInput): DcfResult {
  const currency = assertCurrency(input.currency);
  if (input.freeCashFlows.length === 0) {
    throw new KernelError("VALUATION_INVALID_ASSUMPTION", "DCF requires at least one free cash flow");
  }

  const wacc = decimal(input.wacc, "wacc");
  const growth = decimal(input.terminalGrowth, "terminalGrowth");
  const netDebt = decimal(input.netDebt, "netDebt");
  const nonOperating = decimal(input.nonOperatingAssets, "nonOperatingAssets");
  const otherClaims = decimal(input.otherClaims, "otherClaims");
  const one = new AnalyticalDecimal(1);

  if (wacc.lte(growth)) {
    throw new KernelError(
      "VALUATION_INVALID_ASSUMPTION",
      "WACC must be greater than terminal growth",
    );
  }
  if (one.plus(wacc).lte(0)) {
    throw new KernelError("VALUATION_INVALID_ASSUMPTION", "1 + WACC must be positive");
  }

  const cashFlows = input.freeCashFlows.map((value, index) =>
    decimal(value, `freeCashFlows[${index}]`),
  );
  const last = cashFlows[cashFlows.length - 1];
  if (!last) {
    throw new KernelError("VALUATION_INVALID_ASSUMPTION", "DCF requires at least one free cash flow");
  }

  const periods = cashFlows.length;
  const terminalFreeCashFlow = last.mul(one.plus(growth));
  const terminalValue = terminalFreeCashFlow.div(wacc.minus(growth));
  const discountBase = one.plus(wacc);

  const presentValues = cashFlows.map((cashFlow, index) =>
    cashFlow.div(discountBase.pow(index + 1)),
  );
  const presentValueOfTerminalValue = terminalValue.div(discountBase.pow(periods));
  const enterpriseValue = presentValues.reduce(
    (sum, value) => sum.plus(value),
    presentValueOfTerminalValue,
  );
  const equityValue = enterpriseValue.minus(netDebt).plus(nonOperating).minus(otherClaims);

  return {
    engineVersion: ENGINE_VERSION,
    currency,
    convention: "year_end_gordon_growth",
    terminalCashFlowPolicy: "gordon_from_last_explicit",
    inputHash: hashMaterial({
      currency,
      freeCashFlows: input.freeCashFlows,
      wacc: input.wacc,
      terminalGrowth: input.terminalGrowth,
      netDebt: input.netDebt,
      nonOperatingAssets: input.nonOperatingAssets,
      otherClaims: input.otherClaims,
      convention: "year_end_gordon_growth",
    }),
    terminalFreeCashFlow: canon(terminalFreeCashFlow),
    terminalValue: canon(terminalValue),
    enterpriseValue: canon(enterpriseValue),
    equityValue: canon(equityValue),
    presentValues: presentValues.map((value) => canon(value)),
    presentValueOfTerminalValue: canon(presentValueOfTerminalValue),
  };
}

function decimal(value: string, label: string): Decimal {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new KernelError(
      "VALUATION_INVALID_ASSUMPTION",
      `${label} must be a plain decimal string`,
    );
  }
  return new AnalyticalDecimal(value);
}

function canon(value: Decimal): string {
  return value.toFixed(ANALYTICAL_SCALE);
}
