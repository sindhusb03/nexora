import { describe, expect, it } from "vitest";

import { KernelError, moneyFromDecimal, requireRate, translate } from "../src/index.js";

describe("fx", () => {
  it("rounds half-even and keeps the source amount", () => {
    const even = translate(moneyFromDecimal("USD", "1.00"), {
      rateSetId: "rates-2024",
      base: "USD",
      quote: "EUR",
      rate: "1.005",
      rounding: "half_even",
    });
    const odd = translate(moneyFromDecimal("USD", "1.00"), {
      rateSetId: "rates-2024",
      base: "USD",
      quote: "EUR",
      rate: "1.015",
      rounding: "half_even",
    });

    expect(even.source.minor).toBe("100");
    expect(even.derived.minor).toBe("100");
    expect(odd.derived.minor).toBe("102");
    expect(even.inputHash).not.toBe(odd.inputHash);
  });

  it("fails closed when the rate is missing", () => {
    expect(() => requireRate(null)).toThrowError(
      expect.objectContaining({ code: "FX_RATE_MISSING" }),
    );
    expect(() =>
      translate(moneyFromDecimal("USD", "10.00"), {
        rateSetId: "",
        base: "USD",
        quote: "EUR",
        rate: "0",
        rounding: "half_even",
      }),
    ).toThrow(KernelError);
  });
});
