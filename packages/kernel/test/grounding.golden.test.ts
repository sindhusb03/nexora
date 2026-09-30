import { describe, expect, it } from "vitest";

import { groundModelText } from "../src/index.js";

describe("model grounding", () => {
  it("keeps numbers that appear in tool output and rejects the rest", () => {
    const result = groundModelText(
      "EBITDA is 1,200.00. A hidden total of 9999 was invented. Period 2026 is in the tool output.",
      ["normalized EBITDA 1200.00", "period 2026"],
    );
    expect(result.accepted).toBe(false);
    expect(result.rejectedNumbers).toEqual(["9999"]);
    expect(result.text).toContain("1,200.00");
    expect(result.text).toContain("2026");
    expect(result.text).not.toContain("9999");
    expect(result.text).toContain("[ungrounded]");
  });

  it("treats an ISO date as grounded when that date is in the tool corpus", () => {
    const result = groundModelText("Period 2026-09-30 is closed.", ["period 2026-09-30"]);
    expect(result.accepted).toBe(true);
    expect(result.rejectedNumbers).toEqual([]);
    expect(result.text).toBe("Period 2026-09-30 is closed.");
  });

  it("still rejects a negative amount that the tools did not return", () => {
    const result = groundModelText("Variance is -500.", ["period 2026-09-30"]);
    expect(result.accepted).toBe(false);
    expect(result.rejectedNumbers).toEqual(["-500"]);
  });

  it("accepts a reply whose every number is in the tool corpus", () => {
    const result = groundModelText("Ending cash is 1400.", ["endingMinor 1400"]);
    expect(result.accepted).toBe(true);
    expect(result.rejectedNumbers).toEqual([]);
    expect(result.text).toBe("Ending cash is 1400.");
  });
});
