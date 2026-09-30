import { KernelError } from "./errors.js";
import { translate, type FxRate } from "./fx.js";
import { hashMaterial } from "./hash.js";
import { money, parseMinor } from "./money.js";
import { ENGINE_VERSION } from "./version.js";

export type RateType = "closing" | "historical" | "average";

export interface TrialBalanceLine {
  readonly accountId: string;
  readonly rateType: RateType;
  readonly debitPositiveMinor: string;
}

export interface TranslatedTrialBalance {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly groupCurrency: string;
  readonly rateSetId: string;
  readonly ctaAccountId: string;
  readonly ctaMinor: string;
  readonly lines: readonly { readonly accountId: string; readonly debitPositiveMinor: string }[];
}

/**
 * Translate a balanced trial balance into the group currency.
 * CTA is an explicit equity line equal to the rounding and rate difference.
 * Source amounts are not rewritten.
 */
export function translateTrialBalance(input: {
  readonly sourceCurrency: string;
  readonly lines: readonly TrialBalanceLine[];
  readonly rates: { readonly closing: FxRate; readonly historical: FxRate; readonly average: FxRate };
  readonly ctaAccountId: string;
}): TranslatedTrialBalance {
  if (input.lines.length === 0) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Trial balance is empty");
  }
  if (input.ctaAccountId.length === 0) {
    throw new KernelError("FX_RATE_MISSING", "CTA equity account is required");
  }

  const rateSetId = input.rates.closing.rateSetId;
  for (const rate of [input.rates.closing, input.rates.historical, input.rates.average]) {
    if (rate.rateSetId !== rateSetId || rate.quote !== input.rates.closing.quote) {
      throw new KernelError("FX_INVALID_RATE", "Rate set versions must match");
    }
  }

  let sourceTotal = 0n;
  for (const line of input.lines) {
    if (line.accountId === input.ctaAccountId) {
      throw new KernelError("FX_INVALID_RATE", "CTA account is reserved for the translation plug");
    }
    sourceTotal += parseMinor(line.debitPositiveMinor);
  }
  if (sourceTotal !== 0n) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Source trial balance does not balance");
  }

  const combined = new Map<string, bigint>();
  for (const line of input.lines) {
    const translated = translate(money(input.sourceCurrency, line.debitPositiveMinor), input.rates[line.rateType]);
    combined.set(line.accountId, (combined.get(line.accountId) ?? 0n) + parseMinor(translated.derived.minor));
  }

  let translatedTotal = 0n;
  for (const minor of combined.values()) {
    translatedTotal += minor;
  }
  const ctaMinor = -translatedTotal;
  combined.set(input.ctaAccountId, ctaMinor);

  const lines = [...combined.keys()].sort().map((accountId) => ({
    accountId,
    debitPositiveMinor: (combined.get(accountId) ?? 0n).toString(),
  }));

  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashMaterial({
      sourceCurrency: input.sourceCurrency,
      lines: input.lines,
      rates: input.rates,
      ctaAccountId: input.ctaAccountId,
    }),
    groupCurrency: input.rates.closing.quote,
    rateSetId,
    ctaAccountId: input.ctaAccountId,
    ctaMinor: ctaMinor.toString(),
    lines,
  };
}
