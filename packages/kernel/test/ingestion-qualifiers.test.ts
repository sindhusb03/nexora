import { describe, expect, it } from "vitest";
import { mapLineLabel, mappingIsAutoAcceptable } from "../src/ingestion-mapping.js";

describe("qualifiers and untranslated text retain meaning", () => {
  it.each(["Borrowings", "Term loan"])("requires maturity confirmation for %s", (label) => {
    const hit = mapLineLabel(label);
    expect(hit && mappingIsAutoAcceptable(hit.confidence)).not.toBe(true);
  });
  it.each(["Sales %", "Revenue [%]", "Cash [€]", "Revenue （%）"])(
    "does not erase symbol qualifiers in %s",
    (label) => {
      const hit = mapLineLabel(label);
      expect(hit && mappingIsAutoAcceptable(hit.confidence)).not.toBe(true);
    },
  );
  const bases = ["Revenue", "Cash", "Accounts receivable", "Borrowings", "Operating expenses"];
  const qualifiers = [
    "current",
    "non-current",
    "net",
    "total",
    "units",
    "[restricted]",
    "(net of tax)",
    "and similar",
    "[数量]",
    "（繰延）",
  ];
  it.each(bases.flatMap((base) => qualifiers.map((q) => `${base} ${q}`)))(
    "never auto-accepts %s",
    (label) => {
      const hit = mapLineLabel(label);
      expect(hit && mappingIsAutoAcceptable(hit.confidence)).not.toBe(true);
    },
  );
});
