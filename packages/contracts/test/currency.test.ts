import { describe, expect, it } from "vitest";

import { lookupCurrencyScale } from "../src/index.js";

describe("shared currency scale", () => {
  it("re-exports the ISO 4217 lookup", () => {
    expect(lookupCurrencyScale("JPY")).toEqual({ ok: true, code: "JPY", scale: 0 });
    expect(lookupCurrencyScale("KWD")).toEqual({ ok: true, code: "KWD", scale: 3 });
    expect(lookupCurrencyScale("CLF")).toEqual({ ok: true, code: "CLF", scale: 4 });
    expect(lookupCurrencyScale("XAU")).toEqual({ ok: false, reason: "unsupported" });
  });
});
