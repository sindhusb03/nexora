import { describe, expect, it } from "vitest";

import { explainVariance } from "../src/index.js";

describe("variance", () => {
  it("signs favorable variances by line kind and keeps actual minus plan", () => {
    const result = explainVariance({
      lines: [
        { key: "revenue", label: "Revenue", kind: "revenue", actualMinor: "120", planMinor: "100" },
        { key: "payroll", label: "Payroll", kind: "expense", actualMinor: "80", planMinor: "100" },
        { key: "ebitda", label: "EBITDA", kind: "profit", actualMinor: "40", planMinor: "50" },
        { key: "new", label: "New", kind: "revenue", actualMinor: "10", planMinor: "0" },
      ],
    });

    expect(result.lines).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        kind: "revenue",
        actualMinor: "120",
        planMinor: "100",
        varianceMinor: "20",
        varianceRatio: "0.200000000000",
        favorable: true,
      },
      {
        key: "payroll",
        label: "Payroll",
        kind: "expense",
        actualMinor: "80",
        planMinor: "100",
        varianceMinor: "-20",
        varianceRatio: "-0.200000000000",
        favorable: true,
      },
      {
        key: "ebitda",
        label: "EBITDA",
        kind: "profit",
        actualMinor: "40",
        planMinor: "50",
        varianceMinor: "-10",
        varianceRatio: "-0.200000000000",
        favorable: false,
      },
      {
        key: "new",
        label: "New",
        kind: "revenue",
        actualMinor: "10",
        planMinor: "0",
        varianceMinor: "10",
        varianceRatio: null,
        favorable: true,
      },
    ]);
    expect(result.inputHash).toHaveLength(64);
  });
});
