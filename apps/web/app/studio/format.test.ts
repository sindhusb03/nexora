import { describe, expect, it } from "vitest";
import { axisCurrency, csvCell, minorToAxis, minorToDisplay, withCurrency } from "./format";

describe("currency presentation", () => {
  it.each([
    ["JPY", "1,234", "¥1,234", 1234],
    ["KWD", "1.234", "KWD 1.234", 1.234],
    ["INR", "12.34", "₹12.34", 12.34],
    ["USD", "12.34", "$12.34", 12.34],
  ])("formats %s at its minor scale", (currency, display, symbol, axis) => {
    expect(minorToDisplay("1234", String(currency))).toBe(display);
    expect(withCurrency(String(display), String(currency))).toBe(symbol);
    expect(minorToAxis("1234", String(currency))).toBe(axis);
  });
  it("preserves large and negative amounts exactly", () => {
    expect(minorToDisplay("-900719925474099301", "USD")).toBe("-9,007,199,254,740,993.01");
  });
  it("uses the axis currency symbol", () => {
    expect(axisCurrency(1234, "INR")).toBe("₹1.2k");
    expect(axisCurrency(12, "JPY")).toBe("¥12");
  });
  it.each(["=HYPERLINK(...)", "+cmd", "-cmd", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "neutralises %s",
    (value) => {
      expect(csvCell(value).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );
  it("keeps plain negative decimal amounts numeric and escapes quotes", () => {
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});
