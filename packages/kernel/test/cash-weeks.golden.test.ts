import { describe, expect, it } from "vitest";

import { buildCashForecast } from "../src/index.js";

function weeks(outflowOnWeek2: string) {
  return Array.from({ length: 13 }, (_, index) => ({
    weekIndex: String(index + 1),
    label: `W${index + 1}`,
    inflowMinor: index === 0 ? "400" : "0",
    outflowMinor: index === 1 ? outflowOnWeek2 : "0",
  }));
}

describe("13-week cash", () => {
  it("rolls ending cash into the next week and flags a minimum-cash breach", () => {
    const result = buildCashForecast({
      currency: "USD",
      openingCashMinor: "1000",
      minimumCashMinor: "500",
      weeks: weeks("900"),
    });

    expect(result.weeks[0]).toMatchObject({
      weekIndex: "1",
      beginningMinor: "1000",
      inflowMinor: "400",
      outflowMinor: "0",
      endingMinor: "1400",
      headroomMinor: "900",
      belowMinimum: false,
    });
    expect(result.weeks[1]).toMatchObject({
      beginningMinor: "1400",
      inflowMinor: "0",
      outflowMinor: "900",
      endingMinor: "500",
      headroomMinor: "0",
      belowMinimum: false,
    });
    const tight = buildCashForecast({
      currency: "USD",
      openingCashMinor: "1000",
      minimumCashMinor: "500",
      weeks: weeks("1000"),
    });
    expect(tight.weeks[1]).toMatchObject({
      endingMinor: "400",
      headroomMinor: "-100",
      belowMinimum: true,
    });
    expect(tight.alerts.map((alert) => alert.weekIndex)).toEqual([
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
    ]);
    expect(tight.alerts[0]).toEqual({ weekIndex: "2", endingMinor: "400", shortfallMinor: "100" });
    expect(tight.weeks[12]?.beginningMinor).toBe("400");
    expect(tight.inputHash).toHaveLength(64);
  });

  it("requires exactly thirteen weeks", () => {
    expect(() =>
      buildCashForecast({
        currency: "USD",
        openingCashMinor: "1",
        minimumCashMinor: "0",
        weeks: weeks("0").slice(0, 12),
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_INVALID_PERIOD" }));
  });
});
