import { describe, expect, it } from "vitest";

import { buildDemoPack } from "../app/review/fixtures";
import { bulkCandidates, modelProgress, moveIndex, selectExceptions } from "../app/review/queue";

const pack = buildDemoPack();

describe("exception queue reducers", () => {
  it("sorts blocking errors ahead of warnings and filters by document text", () => {
    const ranked = selectExceptions(pack.exceptions, pack.documents, {
      severity: "all",
      type: "all",
      documentId: "all",
      search: "",
      sort: "severity",
    });
    expect(ranked[0]?.type).toBe("balance_sheet_equation");
    expect(ranked[1]?.type).toBe("unmapped_account");
    expect(ranked[2]?.severity).toBe("warn");

    const gst = selectExceptions(pack.exceptions, pack.documents, {
      severity: "all",
      type: "all",
      documentId: "all",
      search: "GST",
      sort: "severity",
    });
    expect(gst.map((item) => item.type)).toEqual(["tax_tie"]);
  });

  it("tracks model readiness from blocking errors only", () => {
    const open = modelProgress(pack.exceptions);
    expect(open.blockingOpen).toBe(2);
    expect(open.ready).toBe(false);
    const cleared = modelProgress(
      pack.exceptions.map((item) =>
        item.severity === "error" ? { ...item, status: "corrected" as const } : item,
      ),
    );
    expect(cleared.blockingOpen).toBe(0);
    expect(cleared.ready).toBe(true);
    expect(cleared.resolved).toBe(2);
    expect(modelProgress([]).ready).toBe(true);
    expect(modelProgress([]).blockingOpen).toBe(0);
  });

  it("moves the selection without wrapping", () => {
    expect(moveIndex(0, -1, 4)).toBe(0);
    expect(moveIndex(3, 1, 4)).toBe(3);
    expect(moveIndex(1, 1, 4)).toBe(2);
  });

  it("offers bulk accept only for open high-confidence advisory items", () => {
    const eligible = bulkCandidates(pack.exceptions).map((item) => item.type);
    expect(eligible).toEqual(["header_as_value"]);
    expect(eligible).not.toContain("low_confidence_extraction");
    const confidentLow = pack.exceptions.map((item) =>
      item.type === "low_confidence_extraction" ? { ...item, confidence: "0.9900" } : item,
    );
    expect(bulkCandidates(confidentLow).map((item) => item.type)).not.toContain(
      "low_confidence_extraction",
    );
    const numberedHeader = pack.exceptions.map((item) =>
      item.type === "header_as_value"
        ? { ...item, values: { ...item.values, actual: "100" } }
        : item,
    );
    expect(bulkCandidates(numberedHeader).map((item) => item.type)).not.toContain(
      "header_as_value",
    );
    expect(eligible).not.toContain("duplicate_extraction");
    expect(eligible).not.toContain("unit_scale");
    expect(eligible).not.toContain("sign_convention");
    expect(eligible).not.toContain("cash_rollforward");
    expect(eligible).not.toContain("balance_sheet_equation");
  });
});
