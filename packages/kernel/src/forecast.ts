import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import { AnalyticalDecimal } from "./money.js";
import { projectScenario } from "./scenario.js";
import { ENGINE_VERSION } from "./version.js";

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

export interface ForecastDrivers {
  readonly revenueMinor: string;
  readonly growthRate: string;
  readonly grossMargin: string;
  readonly opexMinor: string;
  readonly periods: number;
}

export interface ForecastMonth {
  readonly period: string;
  readonly revenueMinor: string;
  readonly cogsMinor: string;
  readonly grossProfitMinor: string;
  readonly opexMinor: string;
  readonly ebitdaMinor: string;
}

export interface ForecastResult {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly months: readonly ForecastMonth[];
}

/**
 * Driver forecast in integer minor units.
 * Period 1 is the opening run-rate. Later periods compound growth.
 * EBITDA is gross profit minus opex after each component is rounded half-even.
 */
export function forecastDrivers(input: ForecastDrivers): ForecastResult {
  if (!Number.isInteger(input.periods) || input.periods < 1 || input.periods > 36) {
    throw new KernelError("FIN_INVALID_PERIOD", "A driver forecast covers 1 to 36 periods");
  }
  const growth = decimal(input.growthRate, "growthRate");
  const margin = decimal(input.grossMargin, "grossMargin");
  if (margin.lt(0) || margin.gt(1)) {
    throw new KernelError("FIN_AMOUNT_SCALE", "Gross margin must be between 0 and 1");
  }
  const opex = minor(input.opexMinor, "opexMinor");
  let revenue = minor(input.revenueMinor, "revenueMinor");
  const months: ForecastMonth[] = [];
  for (let index = 0; index < input.periods; index += 1) {
    if (index > 0) {
      revenue = revenue.mul(new AnalyticalDecimal(1).plus(growth)).toDecimalPlaces(0);
    }
    const cogs = revenue.mul(new AnalyticalDecimal(1).minus(margin)).toDecimalPlaces(0);
    const gross = revenue.minus(cogs);
    const ebitda = gross.minus(opex);
    months.push({
      period: String(index + 1),
      revenueMinor: revenue.toFixed(0),
      cogsMinor: cogs.toFixed(0),
      grossProfitMinor: gross.toFixed(0),
      opexMinor: opex.toFixed(0),
      ebitdaMinor: ebitda.toFixed(0),
    });
  }
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({
      revenueMinor: input.revenueMinor,
      growthRate: input.growthRate,
      grossMargin: input.grossMargin,
      opexMinor: input.opexMinor,
      periods: String(input.periods),
    }),
    months,
  };
}

/** A scenario is a new driver set. The base forecast is recomputed and left unchanged. */
export function forecastScenario(
  base: ForecastDrivers,
  overrides: Partial<Omit<ForecastDrivers, "periods">> & { readonly periods?: string },
): { readonly base: ForecastResult; readonly scenario: ForecastResult } {
  const baseRecord: {
    revenueMinor: string;
    growthRate: string;
    grossMargin: string;
    opexMinor: string;
    periods: string;
  } = {
    revenueMinor: base.revenueMinor,
    growthRate: base.growthRate,
    grossMargin: base.grossMargin,
    opexMinor: base.opexMinor,
    periods: String(base.periods),
  };
  const overridesRecord: Partial<typeof baseRecord> = {};
  if (overrides.revenueMinor !== undefined) overridesRecord.revenueMinor = overrides.revenueMinor;
  if (overrides.growthRate !== undefined) overridesRecord.growthRate = overrides.growthRate;
  if (overrides.grossMargin !== undefined) overridesRecord.grossMargin = overrides.grossMargin;
  if (overrides.opexMinor !== undefined) overridesRecord.opexMinor = overrides.opexMinor;
  if (overrides.periods !== undefined) overridesRecord.periods = overrides.periods;
  const projected = projectScenario<typeof baseRecord>(baseRecord, overridesRecord);
  return {
    base: forecastDrivers(driversFrom(projected.base)),
    scenario: forecastDrivers(driversFrom(projected.scenario)),
  };
}

function driversFrom(record: {
  readonly revenueMinor: string;
  readonly growthRate: string;
  readonly grossMargin: string;
  readonly opexMinor: string;
  readonly periods: string;
}): ForecastDrivers {
  if (!/^\d+$/.test(record.periods)) {
    throw new KernelError("FIN_INVALID_PERIOD", "Forecast periods must be an integer string");
  }
  return {
    revenueMinor: record.revenueMinor,
    growthRate: record.growthRate,
    grossMargin: record.grossMargin,
    opexMinor: record.opexMinor,
    periods: Number(record.periods),
  };
}

function decimal(value: string, label: string): InstanceType<typeof AnalyticalDecimal> {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new KernelError("FIN_AMOUNT_SCALE", `${label} must be a decimal string`);
  }
  return new AnalyticalDecimal(value);
}

function minor(value: string, label: string): InstanceType<typeof AnalyticalDecimal> {
  const parsed = decimal(value, label);
  if (parsed.decimalPlaces() > 0) {
    throw new KernelError("FIN_AMOUNT_SCALE", `${label} must be integer minor units`);
  }
  return parsed;
}
