import { describe, expect, it } from "vitest";

import {
  BULK_ACCEPT_MIN_CONFIDENCE,
  EXCEPTION_TYPES,
  bulkAcceptExceptions,
  canResolveIngestion,
  confidenceBps,
  confidenceSchema,
  exceptionSchema,
  isBulkCandidate,
  minorUnitSchema,
  resolveException,
  validateUpload,
  type Exception,
  type ResolveRequest,
} from "../src/index.js";

const at = "2026-09-30T12:00:00.000Z";

function exception(overrides: Partial<Exception> = {}): Exception {
  const base: Exception = {
    id: "ex_balance",
    jobId: "job_1",
    documentId: "doc_1",
    valueIds: ["val_1"],
    type: "balance_sheet_equation",
    severity: "error",
    message: "Assets do not equal liabilities and equity.",
    values: {
      expected: "12420000000",
      actual: "12500000000",
      diff: "80000000",
      currency: "INR",
    },
    confidence: "0.9700",
    provenance: [
      {
        documentId: "doc_1",
        fileName: "Meridian_Balance_Sheet_FY2025.pdf",
        page: 1,
        sheet: null,
        row: null,
        col: null,
        bbox: { x: 72, y: 640, width: 220, height: 16 },
        rawText: "Total assets 12,50,00,000",
      },
    ],
    status: "open",
    mappedAccount: null,
    resolution: null,
    auditTrail: [],
  };
  return { ...base, ...overrides };
}

function request(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
  return {
    action: "accept",
    note: null,
    correctedMinor: null,
    accountCode: null,
    idempotencyKey: "idem-accept-1",
    ...overrides,
  };
}

describe("ingestion schemas", () => {
  it("rejects floating money and out-of-range confidence", () => {
    expect(minorUnitSchema.safeParse("12.50").success).toBe(false);
    expect(minorUnitSchema.safeParse("12500000000").success).toBe(true);
    expect(confidenceSchema.safeParse("1.2").success).toBe(false);
    expect(confidenceSchema.safeParse("0.9700").success).toBe(true);
  });

  it("parses an open exception and keeps every check type name", () => {
    expect(exceptionSchema.parse(exception()).type).toBe("balance_sheet_equation");
    expect(EXCEPTION_TYPES).toHaveLength(14);
  });

  it("rejects an empty upload and a file whose declared type does not match", () => {
    const csv = validateUpload({
      idempotencyKey: "idem-upload-csv",
      files: [
        {
          fileName: "statement.csv",
          mediaType: "text/csv",
          byteLength: 1,
          contentBase64: "QQ==",
        },
      ],
    });
    expect(csv.ok).toBe(true);

    const zero = validateUpload({
      idempotencyKey: "idem-upload-zero",
      files: [
        {
          fileName: "blank.csv",
          mediaType: "text/csv",
          byteLength: 0,
          contentBase64: "",
        },
      ],
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.code).toBe("INGESTION_EMPTY_UPLOAD");

    const mismatched = validateUpload({
      idempotencyKey: "idem-upload-mismatch",
      files: [
        {
          fileName: "statement.pdf",
          mediaType: "text/csv",
          byteLength: 1,
          contentBase64: "QQ==",
        },
      ],
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("INGESTION_UNSUPPORTED_FILE");
  });
});

describe("resolution transitions", () => {
  it("records a correction without changing the extracted amounts", () => {
    const open = exception();
    const resolved = resolveException(
      open,
      request({
        action: "correct",
        correctedMinor: "12420000000",
        note: "Tie assets to liabilities and equity",
        idempotencyKey: "idem-correct-1",
      }),
      "sindhu",
      at,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.status).toBe("corrected");
    expect(resolved.value.values).toEqual(open.values);
    expect(resolved.value.resolution).toMatchObject({
      by: "sindhu",
      before: "12500000000",
      after: "12420000000",
      note: "Tie assets to liabilities and equity",
    });
    expect(resolved.value.auditTrail).toHaveLength(1);
  });

  it("rejects a second resolution and a float correction", () => {
    const first = resolveException(exception(), request(), "sindhu", at);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = resolveException(
      first.value,
      request({ idempotencyKey: "idem-again" }),
      "sindhu",
      at,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("INGESTION_INVALID_TRANSITION");

    const floated = resolveException(
      exception(),
      request({
        action: "correct",
        correctedMinor: "12.5",
        idempotencyKey: "idem-float",
      }),
      "sindhu",
      at,
    );
    expect(floated.ok).toBe(false);
    if (!floated.ok) expect(floated.error.code).toBe("INGESTION_VALIDATION_FAILED");
  });

  it("requires an account code to remap and nothing else", () => {
    const missing = resolveException(
      exception({ type: "unmapped_account", severity: "error", confidence: "0.6400" }),
      request({ action: "remap", idempotencyKey: "idem-remap-missing" }),
      "sindhu",
      at,
    );
    expect(missing.ok).toBe(false);

    const remapped = resolveException(
      exception({ type: "unmapped_account", severity: "error", confidence: "0.6400" }),
      request({
        action: "remap",
        accountCode: "4000",
        idempotencyKey: "idem-remap",
      }),
      "sindhu",
      at,
    );
    expect(remapped.ok).toBe(true);
    if (!remapped.ok) return;
    expect(remapped.value.status).toBe("remapped");
    expect(remapped.value.resolution?.before).toBeNull();
    expect(remapped.value.resolution?.after).toBe("4000");
    expect(remapped.value.values.actual).toBe("12500000000");

    const moved = resolveException(
      exception({
        type: "sign_convention",
        severity: "warn",
        confidence: "0.9600",
        mappedAccount: "6100",
      }),
      request({
        action: "remap",
        accountCode: "6800",
        idempotencyKey: "idem-remap-from",
      }),
      "sindhu",
      at,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.resolution?.before).toBe("6100");
    expect(moved.value.resolution?.after).toBe("6800");
    expect(moved.value.mappedAccount).toBe("6800");
  });

  it("rejects accept of a numbered header and records the action the reviewer chooses", () => {
    const numbered = exception({
      type: "header_as_value",
      severity: "info",
      confidence: "0.9900",
      values: { expected: null, actual: "100", diff: null, currency: "USD" },
    });
    const rejected = resolveException(
      numbered,
      request({ action: "accept", idempotencyKey: "idem-header-number" }),
      "sindhu",
      at,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("HEADER_VALUE_NOT_ACCEPTABLE");
      expect(rejected.error.details).toMatchObject({ httpStatus: 422 });
    }
    expect(numbered.status).toBe("open");
    expect(numbered.auditTrail).toEqual([]);
    expect(numbered.values.actual).toBe("100");

    const marked = resolveException(
      numbered,
      request({ action: "not_applicable", idempotencyKey: "idem-header-na" }),
      "sindhu",
      at,
    );
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    expect(marked.value.status).toBe("not_applicable");
    expect(marked.value.resolution?.action).toBe("not_applicable");
    expect(marked.value.values.actual).toBe("100");

    const corrected = resolveException(
      numbered,
      request({
        action: "correct",
        correctedMinor: "0",
        idempotencyKey: "idem-header-correct",
      }),
      "sindhu",
      at,
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.status).toBe("corrected");
    expect(corrected.value.resolution?.action).toBe("correct");
    expect(corrected.value.resolution?.after).toBe("0");
    expect(corrected.value.values.actual).toBe("100");

    const empty = resolveException(
      exception({
        type: "header_as_value",
        severity: "info",
        confidence: "0.9900",
        values: { expected: null, actual: null, diff: null, currency: "USD" },
      }),
      request({ action: "accept", idempotencyKey: "idem-header-empty" }),
      "sindhu",
      at,
    );
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.status).toBe("accepted");
    expect(empty.value.resolution?.action).toBe("accept");
  });

  it("allows owner and controller to resolve, and blocks a viewer", () => {
    expect(canResolveIngestion(["owner"])).toBe(true);
    expect(canResolveIngestion(["controller"])).toBe(true);
    expect(canResolveIngestion(["viewer"])).toBe(false);
    expect(canResolveIngestion(["platform-admin"])).toBe(false);
  });
});

describe("bulk accept", () => {
  it.each(["expected", "actual", "diff"] as const)(
    "rejects accept and bulk accept for a header with non-null %s, including zero",
    (field) => {
      const header = exception({
        type: "header_as_value",
        severity: "info",
        confidence: "0.9900",
        values: { expected: null, actual: null, diff: null, currency: "USD", [field]: "0" },
      });
      const before = structuredClone(header);
      const result = resolveException(header, request(), "sindhu", at);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "HEADER_VALUE_NOT_ACCEPTABLE",
          message: expect.any(String),
          details: { httpStatus: 422 },
        },
      });
      expect(isBulkCandidate(header)).toBe(false);
      expect(
        bulkAcceptExceptions(
          [header],
          {
            jobId: header.jobId,
            exceptionIds: [header.id],
            note: null,
            idempotencyKey: "header-bulk",
          },
          "sindhu",
          at,
        ),
      ).toMatchObject({ ok: false, error: { code: "INGESTION_BULK_REJECTED" } });
      expect(header).toEqual(before);
    },
  );

  it.each([
    ["header_as_value", "0.9900", "100"],
    ["low_confidence_extraction", "0.9900", null],
    ["missing_period", "0.8999", null],
  ] as const)("rejects a mixed bulk set atomically for %s at %s", (type, confidence, actual) => {
    const eligible = exception({
      id: "eligible",
      type: "header_as_value",
      severity: "info",
      confidence: "0.9000",
      values: { expected: null, actual: null, diff: null, currency: "USD" },
    });
    const excluded = {
      ...eligible,
      id: "excluded",
      type,
      confidence,
      values: { ...eligible.values, actual },
    };
    const items = [eligible, excluded];
    const before = structuredClone(items);
    expect(isBulkCandidate(eligible)).toBe(true);
    expect(
      bulkAcceptExceptions(
        items,
        {
          jobId: eligible.jobId,
          exceptionIds: items.map((item) => item.id),
          note: null,
          idempotencyKey: "mixed-bulk",
        },
        "sindhu",
        at,
      ),
    ).toMatchObject({ ok: false, error: { code: "INGESTION_BULK_REJECTED" } });
    expect(items).toEqual(before);
  });

  const advisory = exception({
    id: "ex_header",
    type: "header_as_value",
    severity: "info",
    confidence: "0.9900",
    message: "A header was read as a number.",
    values: { expected: null, actual: null, diff: null, currency: "USD" },
  });
  const low = exception({
    id: "ex_low",
    type: "low_confidence_extraction",
    severity: "warn",
    confidence: "0.9900",
    message: "Ending balance is below the review threshold.",
  });
  const numberedHeader = exception({
    id: "ex_header_number",
    type: "header_as_value",
    severity: "info",
    confidence: "0.9900",
    message: "A header was stored as an amount.",
    values: { expected: null, actual: "100", diff: null, currency: "USD" },
  });
  const blocking = exception();
  const duplicate = exception({
    id: "ex_duplicate",
    type: "duplicate_extraction",
    severity: "warn",
    confidence: "0.9900",
    message: "Revenue was extracted twice.",
    values: {
      expected: "4800000000",
      actual: "9600000000",
      diff: "4800000000",
      currency: "INR",
    },
  });
  const scale = exception({
    id: "ex_scale",
    type: "unit_scale",
    severity: "warn",
    confidence: "0.9550",
    message: "Employee benefit expense looks stated in lakhs.",
    values: {
      expected: "186000000",
      actual: "1860",
      diff: "-185998140",
      currency: "INR",
    },
  });
  const sign = exception({
    id: "ex_sign",
    type: "sign_convention",
    severity: "warn",
    confidence: BULK_ACCEPT_MIN_CONFIDENCE,
    message: "Salaries were extracted as a credit.",
    values: {
      expected: "4200000",
      actual: "-4200000",
      diff: "-8400000",
      currency: "USD",
    },
  });

  it("accepts only open high-confidence advisory items", () => {
    expect(isBulkCandidate(advisory)).toBe(true);
    expect(isBulkCandidate(low)).toBe(false);
    expect(isBulkCandidate(numberedHeader)).toBe(false);
    expect(isBulkCandidate(blocking)).toBe(false);
    expect(isBulkCandidate(duplicate)).toBe(false);
    expect(isBulkCandidate(scale)).toBe(false);
    expect(isBulkCandidate(sign)).toBe(false);
    expect(confidenceBps("0.9700")).toBe(9700);

    const mixed = bulkAcceptExceptions(
      [blocking, advisory, low, duplicate, scale, sign],
      {
        jobId: "job_1",
        exceptionIds: [low.id, duplicate.id, scale.id, sign.id],
        note: null,
        idempotencyKey: "idem-bulk-bad",
      },
      "sindhu",
      at,
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.error.code).toBe("INGESTION_BULK_REJECTED");
    expect(low.status).toBe("open");
    expect(duplicate.status).toBe("open");
    expect(scale.status).toBe("open");
    expect(sign.status).toBe("open");

    const accepted = bulkAcceptExceptions(
      [blocking, advisory, low, duplicate, scale, sign],
      {
        jobId: "job_1",
        exceptionIds: [advisory.id],
        note: "Header is not a value",
        idempotencyKey: "idem-bulk-ok",
      },
      "sindhu",
      at,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.find((item) => item.id === advisory.id)?.status).toBe("accepted");
    expect(accepted.value.find((item) => item.id === duplicate.id)?.status).toBe("open");
    expect(accepted.value.find((item) => item.id === scale.id)?.status).toBe("open");
    expect(accepted.value.find((item) => item.id === sign.id)?.status).toBe("open");
    expect(accepted.value.find((item) => item.id === blocking.id)?.status).toBe("open");
  });
});
