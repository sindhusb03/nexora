import { bulkAcceptExceptions, isBulkCandidate, type Exception } from "@nexora/contracts";
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
  it.each([
    ["header_as_value", "0.9900", "100"],
    ["low_confidence_extraction", "0.9900", null],
    ["missing_period", "0.8999", null],
  ] as const)(
    "rejects %s in a mixed bulk request without resolving or auditing any item",
    (type, confidence, actual) => {
      const eligible = { ...item("header_as_value", "0.9000", null), id: "eligible" };
      const excluded = item(type, confidence, actual);
      const items = [eligible, excluded];
      const before = structuredClone(items);
      const result = bulkAcceptExceptions(
        items,
        {
          jobId: "job_1",
          exceptionIds: items.map((entry) => entry.id),
          note: null,
          idempotencyKey: "bulk-header-probe",
        },
        "sindhu",
        "2026-09-30T12:00:00.000Z",
      );
      expect(result).toMatchObject({ ok: false, error: { code: "INGESTION_BULK_REJECTED" } });
      expect(items).toEqual(before);
      for (const entry of items) {
        expect(entry.status).toBe("open");
        expect(entry.resolution).toBeNull();
        expect(entry.auditTrail).toHaveLength(0);
      }
    },
  );

  it("never bulk-accepts a low-confidence extraction, even at high confidence", () => {
    expect(isBulkCandidate(item("low_confidence_extraction", "0.9900", "4800000"))).toBe(false);
  });

  it("bulk-accepts an empty header and refuses one that contains a number", () => {
    expect(isBulkCandidate(item("header_as_value", "0.9900", null))).toBe(true);
    expect(isBulkCandidate(item("header_as_value", "0.9900", "100"))).toBe(false);
  });
});
