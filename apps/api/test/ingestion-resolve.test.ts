import { resolveException, type Exception } from "@nexora/contracts";
import { describe, expect, it } from "vitest";

const at = "2026-09-30T12:00:00.000Z";

function header(actual: string | null): Exception {
  return {
    id: "ex_header",
    jobId: "job_1",
    documentId: "doc_1",
    valueIds: ["val_1"],
    type: "header_as_value",
    severity: "info",
    message: "A header was read as a number.",
    values: { expected: null, actual, diff: null, currency: "USD" },
    confidence: "0.9900",
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

describe("numbered header accept", () => {
  it("returns 422 HEADER_VALUE_NOT_ACCEPTABLE and does not write the audit trail", () => {
    const open = header("100");
    const resolved = resolveException(
      open,
      {
        action: "accept",
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "idem-header-number",
      },
      "sindhu",
      at,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("HEADER_VALUE_NOT_ACCEPTABLE");
    expect(resolved.error.details).toMatchObject({ httpStatus: 422 });
    expect(open.status).toBe("open");
    expect(open.resolution).toBeNull();
    expect(open.auditTrail).toEqual([]);
    expect(open.values.actual).toBe("100");
  });
});
