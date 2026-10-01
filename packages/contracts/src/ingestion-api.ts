import { z } from "zod";

/**
 * Server wire contract for the ingestion engine routes (apps/api/src/ingestion).
 * Amounts are plain decimal strings. The review UI contract lives in ./ingestion.ts.
 */
export const ingestionSeveritySchema = z.enum(["error", "warn", "info"]);
export const exceptionStatusSchema = z.enum([
  "open",
  "accepted",
  "corrected",
  "remapped",
  "not_applicable",
]);
export const resolveActionSchema = z.enum(["accept", "correct", "remap", "not_applicable"]);

const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/, "Amount must be a plain decimal string");
const confidenceText = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Confidence must be a plain decimal string");

export const resolveExceptionSchema = z
  .object({
    action: resolveActionSchema,
    note: z.string().trim().min(1).max(2_000),
    amount: decimalText.optional(),
    accountCode: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.action === "correct" && value.amount === undefined) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "A corrected amount is required",
      });
    }
    if (value.action === "remap" && value.accountCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["accountCode"],
        message: "An account code is required",
      });
    }
  });

export const bulkAcceptSchema = z.object({
  jobId: z.uuid(),
  minConfidence: confidenceText,
});

export const exceptionQuerySchema = z.object({
  severity: ingestionSeveritySchema.optional(),
  type: z.string().trim().min(1).max(64).optional(),
  documentId: z.uuid().optional(),
});

export const apiBboxSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});

export const apiProvenanceSchema = z.object({
  fileName: z.string(),
  page: z.number().int().nullable(),
  sheet: z.string().nullable(),
  row: z.number().int().nullable(),
  col: z.number().int().nullable(),
  bbox: apiBboxSchema.nullable(),
  rawText: z.string(),
});

export const apiExtractedValueSchema = z.object({
  valueId: z.uuid(),
  documentId: z.uuid(),
  statementType: z.string(),
  role: z.string(),
  label: z.string(),
  periodKey: z.string().nullable(),
  periodEnd: z.string().nullable(),
  currency: z.string().nullable(),
  scale: z.string(),
  minor: z.string().nullable(),
  accountCode: z.string().nullable(),
  mappingConfidence: z.string().nullable(),
  mappingMethod: z.string().nullable(),
  mappingAccepted: z.boolean(),
  provenance: apiProvenanceSchema,
});

export const apiExceptionSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  documentId: z.uuid().nullable(),
  type: z.string(),
  severity: ingestionSeveritySchema,
  message: z.string(),
  values: z.object({
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    diff: z.string().nullable(),
  }),
  provenance: z.object({
    valueIds: z.array(z.string()),
    locations: z.array(apiProvenanceSchema),
  }),
  status: exceptionStatusSchema,
  resolution: z
    .object({
      by: z.string(),
      at: z.string(),
      note: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .nullable(),
});

export const ingestionJobSchema = z.object({
  jobId: z.uuid(),
  entityId: z.uuid(),
  status: z.enum([
    "queued",
    "extracting",
    "mapping",
    "validating",
    "needs_review",
    "building",
    "posted",
    "failed",
  ]),
  currency: z.string().nullable(),
  formulaVersion: z.string().nullable(),
  inputHash: z.string().nullable(),
  outputHash: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  documents: z.array(
    z.object({
      documentId: z.uuid(),
      fileName: z.string(),
      status: z.enum(["pending", "parsed", "failed"]),
      statementKinds: z.array(z.string()),
      error: z.string().nullable(),
    }),
  ),
  counts: z.object({
    documents: z.number().int(),
    values: z.number().int(),
    exceptionsOpen: z.number().int(),
    exceptionsError: z.number().int(),
    exceptionsWarn: z.number().int(),
    exceptionsInfo: z.number().int(),
  }),
});

export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;
export type BulkAcceptInput = z.infer<typeof bulkAcceptSchema>;
export type IngestionJobResponse = z.infer<typeof ingestionJobSchema>;
export type ExtractedValueResponse = z.infer<typeof apiExtractedValueSchema>;
export type IngestionExceptionResponse = z.infer<typeof apiExceptionSchema>;
