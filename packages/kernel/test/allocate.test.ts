import { describe, expect, it } from "vitest";

import { KernelError, allocateExact, allocateSplit } from "../src/index.js";

describe("exact allocation", () => {
  it("splits 1001 at 0.50/0.25/0.25 and 100 at 0.335/0.335/0.33", () => {
    expect(allocateSplit("1001", { sm: "0.50", rnd: "0.25", ga: "0.25" })).toEqual({
      sm: "501",
      rnd: "250",
      ga: "250",
    });
    expect(allocateSplit("100", { sm: "0.335", rnd: "0.335", ga: "0.33" })).toEqual({
      sm: "33",
      rnd: "34",
      ga: "33",
    });
  });

  it("rejects a split that is not 100 percent", () => {
    expect(() => allocateSplit("100", { sm: "0.5", rnd: "0.3", ga: "0.3" })).toThrow(
      expect.objectContaining({ code: "CALC_FAILED", message: "split_not_100" }),
    );
  });

  it("breaks half-even ties toward the lower index and keeps a negative total", () => {
    expect(allocateExact("5", ["1", "1"])).toEqual(["3", "2"]);
    expect(allocateExact("3", ["1", "1"])).toEqual(["1", "2"]);
    expect(allocateExact("-1001", ["0.50", "0.25", "0.25"])).toEqual(["-501", "-250", "-250"]);
    const parts = allocateExact("-1001", ["0.50", "0.25", "0.25"]).map(BigInt);
    expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(-1001n);
  });

  it("rejects empty or all-zero weights", () => {
    expect(() => allocateExact("10", [])).toThrow(KernelError);
    expect(() => allocateExact("10", ["0", "0"])).toThrow(
      expect.objectContaining({ code: "CALC_FAILED" }),
    );
  });
});
