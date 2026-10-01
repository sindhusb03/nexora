import { isBulkCandidate, type Exception } from "@nexora/contracts";
import { describe, expect, it } from "vitest";

function item(type: Exception["type"], confidence: string, actual: string | null): Exception {
  return {
    id: type,
    jobId: "job_1",
    documentId: "doc_1",
    valueIds: ["val_1"],
    type,
    severity: "warn",
    message: type,
    values: { expected: null, actual, diff: null, currency: "USD" },
    confidence,
    provenance: [
      {
        documentId: "doc_1",
        fileName: "source.pdf",
        page: 1,
        sheet: null,
        row: null,
        col: null,
        bbox: null,
        rawText: "Amount",
      },
    ],
    status: "open",
    mappedAccount: null,
    resolution: null,
    auditTrail: [],
  };
}

describe("ingestion bulk eligibility", () => {
  it("never bulk-accepts a low-confidence extraction, even at high confidence", () => {
    expect(isBulkCandidate(item("low_confidence_extraction", "0.9900", "4800000"))).toBe(false);
  });

  it("bulk-accepts an empty header and refuses one that contains a number", () => {
    expect(isBulkCandidate(item("header_as_value", "0.9900", null))).toBe(true);
    expect(isBulkCandidate(item("header_as_value", "0.9900", "100"))).toBe(false);
  });
});
