import { describe, expect, it } from "vitest";

import { acceptCitedClaims, groundModelText } from "../src/index.js";

describe("strict evidence", () => {
  it.each([
    ["100", "-100"],
    ["100", "100.50"],
    ["12", "12%"],
    ["12%", "12"],
    ["(100)", "100"],
    ["100", "(100)"],
    ["1,00", "100"],
    ["1.000,50", "1000.50"],
    ["USD100", "-100"],
    ["100USD", "-100"],
    ["1e2", "100"],
    ["−100", "100"],
    ["12 %", "12"],
    ["( 100 )", "100"],
  ])("rejects %s against fact %s", (claim, fact) => {
    expect(groundModelText(claim, [fact]).accepted).toBe(false);
  });
  it.each(["100", "-100", "100.50", "12%", "(100)"])("accepts exact %s", (fact) => {
    expect(groundModelText(fact, [fact]).accepted).toBe(true);
  });
  it("accepts unambiguous thousands separators", () => {
    expect(groundModelText("1,000", ["1000"]).accepted).toBe(true);
  });
  it("rejects unresolved citations, including with no corpus", () => {
    expect(acceptCitedClaims([{ text: "100", citationId: "unknown" }]).discarded).toHaveLength(1);
    expect(groundModelText("100 [unknown]", ["100"]).accepted).toBe(false);
  });
  it("does not ground numbers supplied only as document context", () => {
    expect(
      groundModelText("999", ["100"], { documents: [{ id: "doc", text: "999" }] }).accepted,
    ).toBe(false);
  });
  it("resolves citations only within supplied sources", () => {
    expect(groundModelText("100 [fact]", ["100"], { factIds: ["fact"] }).accepted).toBe(true);
    expect(
      acceptCitedClaims([{ text: "See source", citationId: "doc" }], ["doc"]).accepted,
    ).toHaveLength(1);
  });
  it("checks the numeric text of a markdown link even when its target resolves", () => {
    expect(groundModelText("[100](fact)", ["-100"], { factIds: ["fact"] }).accepted).toBe(false);
  });
});
