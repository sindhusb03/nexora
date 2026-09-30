import { describe, expect, it } from "vitest";

import { filterCommands, STUDIO_COMMANDS } from "../app/studio/commands";
import { axisCurrency, humanizeMinorPhrases, minorToDisplay, percentFromRatio, withCurrency } from "../app/studio/format";

describe("studio presentation", () => {
  it("groups a server minor-unit string without changing the amount", () => {
    expect(minorToDisplay("15800000")).toBe("158,000.00");
    expect(minorToDisplay("-250")).toBe("-2.50");
    expect(withCurrency("158,000.00", "USD")).toBe("$158,000.00");
    expect(withCurrency("-2.50", "USD")).toBe("-$2.50");
  });

  it("shows a kernel ratio as a percent string", () => {
    expect(percentFromRatio("0.053333333333")).toBe("5.33%");
    expect(percentFromRatio(null)).toBe("—");
  });

  it("formats chart ticks and proposal phrases without inventing a new total", () => {
    expect(axisCurrency(1_200_000)).toBe("$1.2M");
    expect(axisCurrency(158_000)).toBe("$158k");
    expect(axisCurrency(-2_500)).toBe("-$2.5k");
    expect(humanizeMinorPhrases("ahead of the 15000000 minor-unit plan", "USD")).toBe("ahead of the $150,000.00 plan");
    expect(humanizeMinorPhrases("450000 minor units of owner travel", "USD")).toBe("$4,500.00 of owner travel");
  });

  it("filters the command palette by label and hint", () => {
    expect(filterCommands(STUDIO_COMMANDS, "cash").map((command) => command.id)).toEqual(["cash"]);
    expect(filterCommands(STUDIO_COMMANDS, "13-week").map((command) => command.id)).toEqual(["cash"]);
    expect(filterCommands(STUDIO_COMMANDS, "").length).toBe(STUDIO_COMMANDS.length);
  });
});
