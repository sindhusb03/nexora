/**
 * ISO 4217 minor-unit scale. Dependency-free so the web app and the kernel
 * share one table. Codes with no minor unit are rejected. Every other
 * three-letter code uses scale 2, including INR, USD, EUR, GBP, AED, SGD,
 * MGA and MRU.
 */

const SCALE_0 = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
] as const;

const SCALE_3 = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"] as const;

const SCALE_4 = ["CLF", "UYW"] as const;

/** No minor unit. Callers must not default these to scale 2. */
const NO_MINOR_UNIT = [
  "XAU",
  "XAG",
  "XPT",
  "XPD",
  "XDR",
  "XSU",
  "XUA",
  "XBA",
  "XBB",
  "XBC",
  "XBD",
  "XTS",
  "XXX",
] as const;

const SCALE_BY_CODE = new Map<string, number>();
for (const code of SCALE_0) SCALE_BY_CODE.set(code, 0);
for (const code of SCALE_3) SCALE_BY_CODE.set(code, 3);
for (const code of SCALE_4) SCALE_BY_CODE.set(code, 4);

const UNSUPPORTED = new Set<string>(NO_MINOR_UNIT);

const CURRENCY_CODE = /^[A-Z]{3}$/;

export type CurrencyScaleLookup =
  | { readonly ok: true; readonly code: string; readonly scale: number }
  | { readonly ok: false; readonly reason: "invalid" | "unsupported" };

export function lookupCurrencyScale(currency: string): CurrencyScaleLookup {
  if (!CURRENCY_CODE.test(currency)) {
    return { ok: false, reason: "invalid" };
  }
  if (UNSUPPORTED.has(currency)) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: true, code: currency, scale: SCALE_BY_CODE.get(currency) ?? 2 };
}

/**
 * Scale this codebase used before the full ISO 4217 table: 0 for JPY, KRW and
 * VND, 3 for BHD, JOD, KWD and OMR, and 2 for every other three-letter code.
 */
const LEGACY_SCALE_0 = new Set(["JPY", "KRW", "VND"]);
const LEGACY_SCALE_3 = new Set(["BHD", "JOD", "KWD", "OMR"]);

export function legacyCurrencyScale(currency: string): number | null {
  if (!CURRENCY_CODE.test(currency)) return null;
  if (LEGACY_SCALE_0.has(currency)) return 0;
  if (LEGACY_SCALE_3.has(currency)) return 3;
  return 2;
}

export interface CurrencyScaleShift {
  readonly code: string;
  /** Minor units the previous table would have applied. */
  readonly previousScale: number;
  /** Minor units now. Null when the code no longer has a minor unit. */
  readonly scale: number | null;
}

/** A code whose stored minor units would be misread after the scale table moved. */
export function currencyScaleShift(currency: string): CurrencyScaleShift | null {
  const code = currency.trim().toUpperCase();
  const previousScale = legacyCurrencyScale(code);
  if (previousScale === null) return null;
  const current = lookupCurrencyScale(code);
  const scale = current.ok ? current.scale : null;
  if (scale === previousScale) return null;
  return { code, previousScale, scale };
}

export function currencyScaleShifts(currencies: readonly string[]): CurrencyScaleShift[] {
  const shifts: CurrencyScaleShift[] = [];
  const seen = new Set<string>();
  for (const currency of currencies) {
    const code = currency.trim().toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    const shift = currencyScaleShift(code);
    if (shift) shifts.push(shift);
  }
  return shifts;
}

export class CurrencyScaleShiftError extends Error {
  readonly shifts: readonly CurrencyScaleShift[];

  constructor(shifts: readonly CurrencyScaleShift[]) {
    const detail = shifts
      .map(
        (shift) =>
          `${shift.code} (${shift.previousScale} to ${shift.scale === null ? "unsupported" : shift.scale})`,
      )
      .join(", ");
    super(
      `Currency minor-unit scale changed for ${detail}. Stored amounts in these currencies would be misread.`,
    );
    this.name = "CurrencyScaleShiftError";
    this.shifts = shifts;
  }
}

export function assertNoCurrencyScaleShift(currencies: readonly string[]): void {
  const shifts = currencyScaleShifts(currencies);
  if (shifts.length > 0) throw new CurrencyScaleShiftError(shifts);
}
