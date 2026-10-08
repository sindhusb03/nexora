import { describe, expect, it } from "vitest";

import { lookupCurrencyScale } from "../src/index.js";

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
});
