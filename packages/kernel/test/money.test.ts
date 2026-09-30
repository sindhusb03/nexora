import { describe, expect, it } from "vitest";

import {
  KernelError,
  addMoney,
  formatMinor,
  hashMaterial,
  money,
  moneyFromDecimal,
  subtractMoney,
} from "../src/index.js";

describe("money", () => {
  it("keeps ledger amounts as integer minor units", () => {
    const cash = moneyFromDecimal("USD", "10.25");
    expect(cash).toEqual({ currency: "USD", minor: "1025", scale: 2 });
    expect(formatMinor(cash.minor, cash.scale)).toBe("10.25");
  });

  it("rejects binary floats and extra scale", () => {
    expect(() => moneyFromDecimal("USD", "10.255")).toThrow(KernelError);
    expect(() => hashMaterial({ amount: 10.25 })).toThrow(KernelError);
    expect(money("JPY", 1500n).scale).toBe(0);
    expect(moneyFromDecimal("BHD", "1.234").minor).toBe("1234");
  });

  it("adds only matching currencies", () => {
    const total = addMoney(moneyFromDecimal("USD", "1.50"), moneyFromDecimal("USD", "2.25"));
    expect(total.minor).toBe("375");
    expect(() => subtractMoney(money("USD", 1n), money("EUR", 1n))).toThrow(KernelError);
  });
});
