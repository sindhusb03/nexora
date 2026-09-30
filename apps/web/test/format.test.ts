import { describe, expect, it } from "vitest";

import { filterCommands, STUDIO_COMMANDS } from "../app/studio/commands";
import { minorToDisplay, percentFromRatio, withCurrency } from "../app/studio/format";

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

  it("filters the command palette by label and hint", () => {
    expect(filterCommands(STUDIO_COMMANDS, "cash").map((command) => command.id)).toEqual(["cash"]);
    expect(filterCommands(STUDIO_COMMANDS, "13-week").map((command) => command.id)).toEqual(["cash"]);
    expect(filterCommands(STUDIO_COMMANDS, "").length).toBe(STUDIO_COMMANDS.length);
  });
});
