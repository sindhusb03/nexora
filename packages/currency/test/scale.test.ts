import { describe, expect, it } from "vitest";

import {
  assertNoCurrencyScaleShift,
  currencyScaleShift,
  lookupCurrencyScale,
} from "../src/index.js";

describe("ISO 4217 minor units", () => {
  it("uses scale 0 for the zero-decimal currencies", () => {
    for (const code of [
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
    ]) {
      expect(lookupCurrencyScale(code)).toEqual({ ok: true, code, scale: 0 });
    }
  });

  it("uses scale 3 for the three-decimal currencies", () => {
    for (const code of ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]) {
      expect(lookupCurrencyScale(code)).toEqual({ ok: true, code, scale: 3 });
    }
  });

  it("uses scale 4 for CLF and UYW", () => {
    expect(lookupCurrencyScale("CLF")).toEqual({ ok: true, code: "CLF", scale: 4 });
    expect(lookupCurrencyScale("UYW")).toEqual({ ok: true, code: "UYW", scale: 4 });
  });

  it("uses scale 2 for other active codes, including MGA and MRU", () => {
    for (const code of ["INR", "USD", "EUR", "GBP", "AED", "SGD", "MGA", "MRU"]) {
      expect(lookupCurrencyScale(code)).toEqual({ ok: true, code, scale: 2 });
    }
  });

  it("rejects codes with no minor unit", () => {
    for (const code of [
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
    ]) {
      expect(lookupCurrencyScale(code)).toEqual({ ok: false, reason: "unsupported" });
    }
  });

  it("rejects codes that are not three letters", () => {
    expect(lookupCurrencyScale("us")).toEqual({ ok: false, reason: "invalid" });
    expect(lookupCurrencyScale("usd")).toEqual({ ok: false, reason: "invalid" });
    expect(lookupCurrencyScale("US1")).toEqual({ ok: false, reason: "invalid" });
  });

  it("flags currencies whose minor-unit scale changed and leaves the old table alone", () => {
    for (const code of ["USD", "EUR", "INR", "JPY", "KRW", "VND", "BHD", "JOD", "KWD", "OMR"]) {
      expect(currencyScaleShift(code)).toBeNull();
    }
    expect(currencyScaleShift("CLP")).toEqual({ code: "CLP", previousScale: 2, scale: 0 });
    expect(currencyScaleShift("ISK")).toEqual({ code: "ISK", previousScale: 2, scale: 0 });
    expect(currencyScaleShift("UGX")).toEqual({ code: "UGX", previousScale: 2, scale: 0 });
    expect(currencyScaleShift("IQD")).toEqual({ code: "IQD", previousScale: 2, scale: 3 });
    expect(currencyScaleShift("LYD")).toEqual({ code: "LYD", previousScale: 2, scale: 3 });
    expect(currencyScaleShift("TND")).toEqual({ code: "TND", previousScale: 2, scale: 3 });
    expect(currencyScaleShift("CLF")).toEqual({ code: "CLF", previousScale: 2, scale: 4 });
    expect(currencyScaleShift("XAU")).toEqual({ code: "XAU", previousScale: 2, scale: null });
    expect(() => assertNoCurrencyScaleShift(["USD", "JPY"])).not.toThrow();
    expect(() => assertNoCurrencyScaleShift(["usd", "CLP"])).toThrow(/CLP/);
  });
});
