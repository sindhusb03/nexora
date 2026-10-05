import { describe, expect, it } from "vitest";
import { statementAmountsEqual } from "../src/index.js";

describe("statement layout equations", () => {
  it("checks gross minus depreciation equals net exactly", () => {
    expect(statementAmountsEqual(["1234.57"], ["234.56", "1000.01"])).toBe(true);
    expect(statementAmountsEqual(["1234.57"], ["234.56", "1000.02"])).toBe(false);
  });
  it("checks two sides without float rounding or a tolerance", () => {
    expect(statementAmountsEqual(["0.1", "0.2"], ["0.3"])).toBe(true);
    expect(statementAmountsEqual(["9007199254740993.01"], ["9007199254740993", "0.01"])).toBe(true);
    expect(statementAmountsEqual(["100"], ["99.99"])).toBe(false);
  });
});
