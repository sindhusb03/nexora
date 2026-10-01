import { z } from "zod";

/**
 * Ingestion contract for extraction review.
 * Amount strings are integer minor units (cents, paise). This module does not
 * add, scale, or post them. Resolutions are proposals for a later kernel path.
 */

export const SEVERITIES = ["error", "warn", "info"] as const;
export const EXCEPTION_STATUSES = [
  "open",
  "accepted",
  "corrected",
  "remapped",
  "not_applicable",
] as const;
export const RESOLVE_ACTIONS = ["accept", "correct", "remap", "not_applicable"] as const;
export const EXCEPTION_TYPES = [
  "balance_sheet_equation",
  "cash_rollforward",
  "retained_earnings_tie",
  "unmapped_account",
  "sign_convention",
  "duplicate_extraction",
  "low_confidence_extraction",
  "currency_mismatch",
  "unit_scale",
  "missing_period",
  "bank_to_book",
  "tax_tie",
  "header_as_value",
  "formula_cached_mismatch",
] as const;
export const JOB_STATUSES = ["queued", "extracting", "checking", "ready", "failed"] as const;
export const MEDIA_TYPES = [
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export const INGESTION_ERROR_CODES = [
  "INGESTION_VALIDATION_FAILED",
  "INGESTION_UNSUPPORTED_FILE",
  "INGESTION_EMPTY_UPLOAD",
  "INGESTION_JOB_NOT_FOUND",
  "INGESTION_JOB_NOT_READY",
  "INGESTION_EXCEPTION_NOT_FOUND",
  "INGESTION_INVALID_TRANSITION",
  "INGESTION_IDEMPOTENCY_CONFLICT",
  "INGESTION_BULK_REJECTED",
  "INGESTION_UNAVAILABLE",
  "HEADER_VALUE_NOT_ACCEPTABLE",
  "AUTH_SCOPE_DENIED",
  "AUTH_CSRF_FAILED",
] as const;

/** Accept of a numbered header is rejected. The reviewer chooses the recorded action. */
export const HEADER_VALUE_NOT_ACCEPTABLE_STATUS = 422;

export const HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE =
  "This header contains a number and cannot be accepted. Choose not applicable or correct.";

export const BULK_ACCEPT_MIN_CONFIDENCE = "0.9000";

export type Severity = (typeof SEVERITIES)[number];
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type MediaType = (typeof MEDIA_TYPES)[number];
export type IngestionErrorCode = (typeof INGESTION_ERROR_CODES)[number];

const mediaByExtension: Record<string, MediaType> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const minorUnitSchema = z
  .string()
  .regex(/^-?\d+$/, "amount must be an integer minor-unit string");

export const confidenceSchema = z
  .string()
  .regex(/^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/, "confidence must be a decimal string from 0 to 1");

export const isoTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, "timestamp must be UTC ISO-8601");

export const ingestionErrorSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1),
  details: z.unknown(),
});

export type IngestionError = z.infer<typeof ingestionErrorSchema>;

/** Wire shape returned by the Hono app: `{ error: { code, message } }`. */
export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export function readApiError(body: unknown): IngestionError | null {
  const parsed = apiErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  return {
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    details: parsed.data.error.details ?? null,
  };
}

export type IngestionResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IngestionError };

/** Owner and controller may record a resolution. Viewer and platform-admin alone may not. */
export function canResolveIngestion(roles: readonly string[]): boolean {
  return roles.includes("owner") || roles.includes("controller");
}

export function mediaTypeForFileName(fileName: string): MediaType | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return mediaByExtension[extension] ?? null;
}

export function confidenceBps(value: string): number | null {
  if (!confidenceSchema.safeParse(value).success) return null;
  const [whole, fraction = ""] = value.split(".");
  const padded = `${fraction}0000`.slice(0, 4);
  return Number(whole) * 10_000 + Number(padded);
}

function ok<T>(value: T): IngestionResult<T> {
  return { ok: true, value };
}

function err(
  code: IngestionErrorCode,
  message: string,
  details: unknown = null,
): IngestionResult<never> {
  return { ok: false, error: { code, message, details } };
}

export const bboxSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const provenanceSchema = z.object({
  documentId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  page: z.number().int().positive().nullable(),
  sheet: z.string().min(1).max(120).nullable(),
  row: z.number().int().positive().nullable(),
  col: z.number().int().positive().nullable(),
  bbox: bboxSchema.nullable(),
  rawText: z.string().max(2_000),
});

export type Provenance = z.infer<typeof provenanceSchema>;

export const sheetWindowSchema = z.object({
  originRow: z.number().int().positive(),
  originCol: z.number().int().positive(),
  highlightRow: z.number().int().positive(),
  highlightCol: z.number().int().positive(),
  cells: z
    .array(z.array(z.string().max(200)).min(1).max(12))
    .min(1)
    .max(20),
});

export const sourceDocumentSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mediaType: z.enum(MEDIA_TYPES),
  pageCount: z.number().int().positive().nullable(),
  sheetNames: z.array(z.string().min(1).max(120)).max(30),
  regionHint: z.enum(["IN", "US", "UK", "EU", "SG", "UAE", "JP", "AU"]).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  entityName: z.string().min(1).max(160),
  pdfBase64: z.string().nullable(),
});

export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const extractedValueSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  documentId: z.string().min(1),
  label: z.string().min(1).max(200),
  statement: z.enum(["income", "balance", "cash", "bank", "tax"]),
  periodLabel: z.string().min(1).max(80).nullable(),
  amountMinor: minorUnitSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  provenance: provenanceSchema,
  sheetWindow: sheetWindowSchema.nullable(),
});

export type ExtractedValue = z.infer<typeof extractedValueSchema>;

export const resolutionSchema = z.object({
  action: z.enum(RESOLVE_ACTIONS),
  by: z.string().min(1).max(120),
  at: isoTimestampSchema,
  note: z.string().max(500).nullable(),
  before: z.string().max(80).nullable(),
  after: z.string().max(80).nullable(),
});

export type Resolution = z.infer<typeof resolutionSchema>;

export const exceptionSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  documentId: z.string().min(1),
  valueIds: z.array(z.string().min(1)).max(8),
  type: z.enum(EXCEPTION_TYPES),
  severity: z.enum(SEVERITIES),
  message: z.string().min(1).max(500),
  values: z.object({
    expected: minorUnitSchema.nullable(),
    actual: minorUnitSchema.nullable(),
    diff: minorUnitSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  confidence: confidenceSchema,
  provenance: z.array(provenanceSchema).min(1).max(8),
  status: z.enum(EXCEPTION_STATUSES),
  mappedAccount: z
    .string()
    .regex(/^[0-9A-Z]{3,12}$/)
    .nullable(),
  resolution: resolutionSchema.nullable(),
  auditTrail: z.array(resolutionSchema).max(20),
});

export type Exception = z.infer<typeof exceptionSchema>;

export const accountSchema = z.object({
  code: z.string().regex(/^[0-9A-Z]{3,12}$/),
  name: z.string().min(1).max(160),
  entityName: z.string().min(1).max(160),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type Account = z.infer<typeof accountSchema>;

export const jobContextSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basis: z.string().min(1).max(80),
  disclaimer: z.string().min(1).max(400),
});

const uploadProgressSchema = z.object({
  fileName: z.string().min(1).max(255),
  mediaType: z.enum(MEDIA_TYPES),
  byteLength: z.number().int().positive(),
  percent: z.number().int().min(0).max(100),
  status: z.enum(["pending", "reading", "extracted", "failed"]),
});

export const extractionJobSchema = z.object({
  id: z.string().min(1),
  status: z.enum(JOB_STATUSES),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  context: jobContextSchema,
  documents: z.array(sourceDocumentSchema).max(30),
  uploads: z.array(uploadProgressSchema).max(20),
  chart: z.array(accountSchema).max(200),
  summary: z
    .object({
      valueCount: z.number().int().nonnegative(),
      exceptionCount: z.number().int().nonnegative(),
      blockingOpen: z.number().int().nonnegative(),
    })
    .nullable(),
  error: ingestionErrorSchema.nullable(),
});

export type ExtractionJob = z.infer<typeof extractionJobSchema>;

const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,200}$/);

export const uploadFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(MEDIA_TYPES),
  byteLength: z.number().int().nonnegative().max(25_000_000),
  contentBase64: z
    .string()
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

export type UploadFile = z.infer<typeof uploadFileSchema>;

export const uploadRequestSchema = z.object({
  files: z.array(uploadFileSchema).min(1).max(20),
  idempotencyKey: idempotencyKeySchema,
});

export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export const resolveRequestSchema = z.object({
  action: z.enum(RESOLVE_ACTIONS),
  note: z.string().max(500).nullable(),
  correctedMinor: minorUnitSchema.nullable(),
  accountCode: z
    .string()
    .regex(/^[0-9A-Z]{3,12}$/)
    .nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

export const bulkAcceptRequestSchema = z.object({
  jobId: z.string().min(1),
  exceptionIds: z.array(z.string().min(1)).min(1).max(200),
  note: z.string().max(500).nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export type BulkAcceptRequest = z.infer<typeof bulkAcceptRequestSchema>;

export const ingestionPaths = {
  uploads: "/v1/ingestion/uploads",
  job: (id: string) => `/v1/ingestion/jobs/${encodeURIComponent(id)}`,
  values: (id: string) => `/v1/ingestion/jobs/${encodeURIComponent(id)}/values`,
  exceptions: (id: string) => `/v1/ingestion/jobs/${encodeURIComponent(id)}/exceptions`,
  resolve: (id: string) => `/v1/ingestion/exceptions/${encodeURIComponent(id)}/resolve`,
  bulkAccept: "/v1/ingestion/exceptions/bulk-accept",
} as const;

const STATUS_FOR_ACTION: Record<ResolveAction, ExceptionStatus> = {
  accept: "accepted",
  correct: "corrected",
  remap: "remapped",
  not_applicable: "not_applicable",
};

/**
 * Advisory items only. A high-confidence check failure (duplicate, scale, sign,
 * roll-forward, tie-out) is a real error and must not be bulk-accepted.
 */
const ADVISORY_BULK_TYPES = new Set<ExceptionType>(["header_as_value", "missing_period"]);

function valuesAreEmpty(values: Exception["values"]): boolean {
  return values.expected === null && values.actual === null && values.diff === null;
}

/** A header row that already holds a number must not be confirmed by Accept. */
export function headerValueNotAcceptable(exception: Pick<Exception, "type" | "values">): boolean {
  return exception.type === "header_as_value" && !valuesAreEmpty(exception.values);
}

export function isBulkCandidate(exception: Exception): boolean {
  const score = confidenceBps(exception.confidence);
  if (headerValueNotAcceptable(exception)) return false;
  return (
    exception.status === "open" &&
    exception.severity !== "error" &&
    ADVISORY_BULK_TYPES.has(exception.type) &&
    score !== null &&
    score >= (confidenceBps(BULK_ACCEPT_MIN_CONFIDENCE) ?? 9_000)
  );
}

function decodedByteLength(contentBase64: string): number | null {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64) ||
    contentBase64.length % 4 !== 0
  ) {
    return null;
  }
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  return (contentBase64.length / 4) * 3 - padding;
}

export function validateUpload(input: unknown): IngestionResult<readonly UploadFile[]> {
  const parsed = uploadRequestSchema.safeParse(input);
  if (!parsed.success) {
    return err("INGESTION_VALIDATION_FAILED", "Upload payload is invalid.", parsed.error.flatten());
  }
  const files: UploadFile[] = [];
  for (const file of parsed.data.files) {
    const expected = mediaTypeForFileName(file.fileName);
    if (!expected) {
      return err(
        "INGESTION_UNSUPPORTED_FILE",
        `${file.fileName} must be an xlsx, csv, or pdf file.`,
        { fileName: file.fileName },
      );
    }
    if (expected !== file.mediaType) {
      return err(
        "INGESTION_UNSUPPORTED_FILE",
        `${file.fileName} does not match the declared file type.`,
        { fileName: file.fileName },
      );
    }
    const decoded = decodedByteLength(file.contentBase64);
    if (decoded === null || decoded !== file.byteLength) {
      return err("INGESTION_VALIDATION_FAILED", `${file.fileName} has an inconsistent size.`, {
        fileName: file.fileName,
      });
    }
    if (decoded === 0) {
      return err("INGESTION_EMPTY_UPLOAD", `${file.fileName} is empty.`, {
        fileName: file.fileName,
      });
    }
    files.push(file);
  }
  return ok(files);
}

function actionFields(body: ResolveRequest): IngestionResult<never> | null {
  if (body.action === "correct") {
    if (body.correctedMinor === null || body.accountCode !== null) {
      return err(
        "INGESTION_VALIDATION_FAILED",
        "A correction requires an integer minor-unit value and no account code.",
      );
    }
    return null;
  }
  if (body.action === "remap") {
    if (body.accountCode === null || body.correctedMinor !== null) {
      return err(
        "INGESTION_VALIDATION_FAILED",
        "A remap requires a chart account code and no corrected amount.",
      );
    }
    return null;
  }
  if (body.correctedMinor !== null || body.accountCode !== null) {
    return err(
      "INGESTION_VALIDATION_FAILED",
      "Accept and not-applicable resolutions cannot carry an amount or account code.",
    );
  }
  return null;
}

export function resolveException(
  exception: Exception,
  request: ResolveRequest,
  actorId: string,
  at: string,
): IngestionResult<Exception> {
  const actor = actorId.trim();
  if (actor.length === 0 || actor.length > 120) {
    return err("INGESTION_VALIDATION_FAILED", "Actor is missing.");
  }
  if (!isoTimestampSchema.safeParse(at).success) {
    return err("INGESTION_VALIDATION_FAILED", "Resolution time must be UTC ISO-8601.");
  }
  const parsed = resolveRequestSchema.safeParse(request);
  if (!parsed.success) {
    return err(
      "INGESTION_VALIDATION_FAILED",
      "Resolution payload is invalid.",
      parsed.error.flatten(),
    );
  }
  const body = parsed.data;
  if (exception.status !== "open") {
    return err(
      "INGESTION_INVALID_TRANSITION",
      `Exception ${exception.id} is ${exception.status} and cannot be resolved again.`,
      { id: exception.id, status: exception.status },
    );
  }
  const fieldError = actionFields(body);
  if (fieldError) return fieldError;
  if (body.action === "accept" && headerValueNotAcceptable(exception)) {
    return err("HEADER_VALUE_NOT_ACCEPTABLE", HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE, {
      httpStatus: HEADER_VALUE_NOT_ACCEPTABLE_STATUS,
      id: exception.id,
    });
  }

  const action = body.action;
  const before =
    action === "accept" || action === "correct"
      ? exception.values.actual
      : action === "remap"
        ? exception.mappedAccount
        : null;
  const after =
    action === "accept"
      ? exception.values.actual
      : action === "correct"
        ? body.correctedMinor
        : action === "remap"
          ? body.accountCode
          : null;
  const resolution: Resolution = {
    action,
    by: actor,
    at,
    note: body.note,
    before,
    after,
  };
  const next: Exception = {
    ...exception,
    status: STATUS_FOR_ACTION[action],
    mappedAccount:
      action === "remap" && body.accountCode !== null ? body.accountCode : exception.mappedAccount,
    resolution,
    auditTrail: [...exception.auditTrail, resolution],
    values: exception.values,
  };
  return ok(next);
}

export function bulkAcceptExceptions(
  exceptions: readonly Exception[],
  request: BulkAcceptRequest,
  actorId: string,
  at: string,
): IngestionResult<readonly Exception[]> {
  const parsed = bulkAcceptRequestSchema.safeParse(request);
  if (!parsed.success) {
    return err(
      "INGESTION_VALIDATION_FAILED",
      "Bulk accept payload is invalid.",
      parsed.error.flatten(),
    );
  }
  const body = parsed.data;
  if (new Set(body.exceptionIds).size !== body.exceptionIds.length) {
    return err("INGESTION_BULK_REJECTED", "Bulk accept lists an exception more than once.");
  }
  const selected: Exception[] = [];
  for (const id of body.exceptionIds) {
    const found = exceptions.find((item) => item.id === id && item.jobId === body.jobId);
    if (!found) {
      return err("INGESTION_EXCEPTION_NOT_FOUND", `Exception ${id} was not found on this job.`, {
        id,
      });
    }
    selected.push(found);
  }
  for (const item of selected) {
    if (!isBulkCandidate(item)) {
      return err(
        "INGESTION_BULK_REJECTED",
        `${item.type} cannot be bulk-accepted. Blocking errors and low-confidence items stay in the queue.`,
        { id: item.id, severity: item.severity, confidence: item.confidence },
      );
    }
  }
  let next = [...exceptions];
  for (const item of selected) {
    const resolved = resolveException(
      item,
      {
        action: "accept",
        note: body.note,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: body.idempotencyKey,
      },
      actorId,
      at,
    );
    if (!resolved.ok) return resolved;
    next = next.map((current) => (current.id === item.id ? resolved.value : current));
  }
  return ok(next);
}
