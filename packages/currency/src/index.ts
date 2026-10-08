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
