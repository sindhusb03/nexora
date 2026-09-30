import { describe, expect, it } from "vitest";

import { KernelError, valueDcf } from "../src/index.js";

describe("dcf", () => {
  const input = {
    currency: "USD",
    freeCashFlows: ["100", "110"],
    wacc: "0.10",
    terminalGrowth: "0.02",
    netDebt: "200",
    nonOperatingAssets: "50",
    otherClaims: "10",
  } as const;

  it("reproduces the hand-calculated year-end Gordon valuation", () => {
    const first = valueDcf(input);
    const second = valueDcf(input);

    expect(first.terminalFreeCashFlow).toBe("112.200000000000");
    expect(first.terminalValue).toBe("1402.500000000000");
    expect(first.presentValues).toEqual(["90.909090909091", "90.909090909091"]);
    expect(first.presentValueOfTerminalValue).toBe("1159.090909090909");
    expect(first.enterpriseValue).toBe("1340.909090909091");
    expect(first.equityValue).toBe("1180.909090909091");
    expect(first).toEqual(second);
    expect(first.inputHash).toBe(second.inputHash);
  });

  it("rejects a terminal growth rate that is not below WACC", () => {
    expect(() => valueDcf({ ...input, terminalGrowth: "0.10" })).toThrowError(
      expect.objectContaining({ code: "VALUATION_INVALID_ASSUMPTION" }),
    );
    expect(() => valueDcf({ ...input, terminalGrowth: "0.12" })).toThrow(KernelError);
  });
});
