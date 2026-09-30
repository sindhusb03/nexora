import { describe, expect, it } from "vitest";

import { forecastDrivers, forecastScenario } from "../src/index.js";

describe("driver forecast", () => {
  it("rolls revenue, margin, and fixed opex without touching the base", () => {
    const result = forecastDrivers({
      revenueMinor: "100000",
      growthRate: "0.10",
      grossMargin: "0.40",
      opexMinor: "20000",
      periods: 3,
    });

    expect(result.months).toEqual([
      {
        period: "1",
        revenueMinor: "100000",
        cogsMinor: "60000",
        grossProfitMinor: "40000",
        opexMinor: "20000",
        ebitdaMinor: "20000",
      },
      {
        period: "2",
        revenueMinor: "110000",
        cogsMinor: "66000",
        grossProfitMinor: "44000",
        opexMinor: "20000",
        ebitdaMinor: "24000",
      },
      {
        period: "3",
        revenueMinor: "121000",
        cogsMinor: "72600",
        grossProfitMinor: "48400",
        opexMinor: "20000",
        ebitdaMinor: "28400",
      },
    ]);
    expect(result.engineVersion).toBe("fe-kernel-0.2.0");
    expect(result.inputHash).toHaveLength(64);

    const compared = forecastScenario(
      {
        revenueMinor: "100000",
        growthRate: "0.10",
        grossMargin: "0.40",
        opexMinor: "20000",
        periods: 2,
      },
      { growthRate: "0.00" },
    );
    expect(compared.base.months[1]?.revenueMinor).toBe("110000");
    expect(compared.scenario.months[1]?.revenueMinor).toBe("100000");
    expect(compared.base.inputHash).not.toBe(compared.scenario.inputHash);
  });

  it("rounds half-even to integer minor units and keeps the EBITDA identity", () => {
    const result = forecastDrivers({
      revenueMinor: "100",
      growthRate: "0.015",
      grossMargin: "0.5",
      opexMinor: "10",
      periods: 2,
    });
    const second = result.months[1];
    expect(second?.revenueMinor).toBe("102");
    expect(second?.cogsMinor).toBe("51");
    expect(second?.grossProfitMinor).toBe("51");
    expect(second?.ebitdaMinor).toBe("41");
  });

  it("rejects a non-decimal driver", () => {
    expect(() =>
      forecastDrivers({
        revenueMinor: "100.5",
        growthRate: "fast",
        grossMargin: "0.4",
        opexMinor: "10",
        periods: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_AMOUNT_SCALE" }));
  });
});
