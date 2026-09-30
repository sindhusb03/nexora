import { KernelError } from "./errors.js";
import { hashMaterial } from "./hash.js";
import {
  AnalyticalDecimal,
  assertCurrency,
  currencyScale,
  money,
  parseMinor,
  type Money,
} from "./money.js";
import { ENGINE_VERSION } from "./version.js";

const PLAIN_POSITIVE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface FxRate {
  readonly rateSetId: string;
  readonly base: string;
  readonly quote: string;
  /** Quote currency units per 1 base currency unit. */
  readonly rate: string;
  readonly rounding: "half_even";
}

export interface TranslatedAmount {
  readonly source: Money;
  readonly derived: Money;
  readonly rateSetId: string;
  readonly rate: string;
  readonly rounding: "half_even";
  readonly engineVersion: string;
  readonly inputHash: string;
}

/**
 * Translation produces a derived amount. The source money object is not replaced.
 * A missing or non-positive rate fails closed. There is no silent fallback.
 */
export function translate(source: Money, rate: FxRate): TranslatedAmount {
  if (rate.rounding !== "half_even") {
    throw new KernelError("FX_INVALID_RATE", "Only half-even rounding is enabled");
  }
  if (rate.rateSetId.length === 0) {
    throw new KernelError("FX_RATE_MISSING", "An approved rate set is required");
  }
  const base = assertCurrency(rate.base);
  const quote = assertCurrency(rate.quote);
  if (source.currency !== base) {
    throw new KernelError("FX_INVALID_RATE", "Rate base currency does not match the source");
  }
  if (!PLAIN_POSITIVE.test(rate.rate) || new AnalyticalDecimal(rate.rate).lte(0)) {
    throw new KernelError("FX_RATE_MISSING", "Approved FX rate is unavailable");
  }

  const scale = source.scale;
  const amount = new AnalyticalDecimal(parseMinor(source.minor).toString()).div(
    new AnalyticalDecimal(10).pow(scale),
  );
  const targetScale = currencyScale(quote);
  const rounded = amount
    .mul(new AnalyticalDecimal(rate.rate))
    .toDecimalPlaces(targetScale, AnalyticalDecimal.ROUND_HALF_EVEN);

  return {
    source,
    derived: money(quote, rounded.mul(new AnalyticalDecimal(10).pow(targetScale)).toFixed(0)),
    rateSetId: rate.rateSetId,
    rate: rate.rate,
    rounding: "half_even",
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({
      minor: source.minor,
      currency: source.currency,
      rateSetId: rate.rateSetId,
      base,
      quote,
      rate: rate.rate,
      rounding: rate.rounding,
    }),
  };
}

export function requireRate(rate: FxRate | null): FxRate {
  if (!rate) {
    throw new KernelError("FX_RATE_MISSING", "Approved FX rate is unavailable");
  }
  return rate;
}
