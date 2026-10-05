import { and, asc, eq } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import {
  ingestionAccountMapping,
  extractedValue,
  ingestionException,
  ingestionJob,
  sourceDocument,
} from "./ingestion-schema.js";
import type { AuditWrite } from "./records.js";
import { tenantTx, writeAudit } from "./store.js";

export interface IngestionJobWrite {
  readonly tenantId: string;
  readonly jobId: string;
  readonly entityId: string;
  readonly status: string;
  readonly currency: string | null;
  readonly idempotencyKey: string | null;
  readonly contentHash: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly audit: AuditWrite;
}

export interface IngestionJobPatch {
  readonly tenantId: string;
  readonly jobId: string;
  readonly status: string;
  readonly currency: string | null;
  readonly formulaVersion: string | null;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly modelPayload: Record<string, unknown> | null;
  readonly canonicalHash?: string | null;
  readonly updatedAt: string;
}

export interface SourceDocumentWrite {
  readonly tenantId: string;
  readonly documentId: string;
  readonly jobId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly parserId: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly parseIssues: readonly {
    readonly code: string;
    readonly message: string;
    readonly raw: string;
    readonly page: number | null;
  }[];
  readonly statementKinds: string;
  readonly createdAt: string;
}

export interface ExtractedValueWrite {
  readonly valueId: string;
  readonly documentId: string;
  readonly statementType: string;
  readonly role: string;
  readonly label: string;
  readonly periodKey: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly spanMonths: number;
  readonly currency: string | null;
  readonly scale: string;
  readonly amountMinor: string | null;
  readonly rawText: string;
  readonly page: number | null;
  readonly sheet: string | null;
  readonly rowNo: number | null;
  readonly colNo: number | null;
  readonly bbox: Record<string, number> | null;
  readonly accountCode: string | null;
  readonly mappingConfidence: string | null;
  readonly mappingMethod: string | null;
  readonly mappingAccepted: boolean;
  readonly contra: boolean;
  readonly balanceKind: string;
  readonly sortOrder: number;
  readonly sectionId: string;
}

export interface AccountMappingWrite {
  readonly mappingId: string;
  readonly valueId: string;
  readonly accountCode: string;
  readonly confidence: string;
  readonly method: string;
  readonly accepted: boolean;
  readonly createdAt: string;
}

export interface IngestionExceptionWrite {
  readonly exceptionId: string;
  readonly documentId: string | null;
  readonly type: string;
  readonly severity: string;
  readonly message: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly diff: string | null;
  readonly provenance: Record<string, unknown>;
  readonly status: string;
  readonly createdAt: string;
}

export interface ExceptionResolutionWrite {
  readonly tenantId: string;
  readonly exceptionId: string;
  readonly status: string;
  readonly resolution: Record<string, unknown>;
  readonly updatedAt: string;
  readonly audit: AuditWrite;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function createIngestionStore(db: AppDatabase) {
  return {
    insertIngestionJob(input: IngestionJobWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(ingestionJob).values({
          ingestionJobId: input.jobId,
          tenantId: input.tenantId,
          legalEntityId: input.entityId,
          status: input.status,
          currency: input.currency,
          formulaVersion: null,
          inputHash: null,
          outputHash: null,
          modelPayload: null,
          idempotencyKey: input.idempotencyKey,
          contentHash: input.contentHash,
          actorId: input.actorId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },

    findIngestionJobByKey(tenantId: string, idempotencyKey: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ingestionJob)
          .where(
            and(
              eq(ingestionJob.tenantId, tenantId),
              eq(ingestionJob.idempotencyKey, idempotencyKey),
            ),
          );
        const row = rows[0];
        return row ? mapJob(row) : null;
      });
    },

    findPostedIngestionByCanonical(tenantId: string, entityId: string, canonicalHash: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ingestionJob)
          .where(
            and(
              eq(ingestionJob.tenantId, tenantId),
              eq(ingestionJob.legalEntityId, entityId),
              eq(ingestionJob.canonicalHash, canonicalHash),
              eq(ingestionJob.status, "posted"),
            ),
          )
          .orderBy(asc(ingestionJob.createdAt));
        const row = rows[0];
        return row ? mapJob(row) : null;
      });
    },

    findIngestionJobByContent(tenantId: string, entityId: string, contentHash: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ingestionJob)
          .where(
            and(
              eq(ingestionJob.tenantId, tenantId),
              eq(ingestionJob.legalEntityId, entityId),
              eq(ingestionJob.contentHash, contentHash),
            ),
          )
          .orderBy(asc(ingestionJob.createdAt));
        const row = rows[0];
        return row ? mapJob(row) : null;
      });
    },

    getIngestionJob(tenantId: string, jobId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ingestionJob)
          .where(and(eq(ingestionJob.tenantId, tenantId), eq(ingestionJob.ingestionJobId, jobId)));
        const row = rows[0];
        return row ? mapJob(row) : null;
      });
    },

    updateIngestionJob(input: IngestionJobPatch) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx
          .update(ingestionJob)
          .set({
            status: input.status,
            currency: input.currency,
            formulaVersion: input.formulaVersion,
            inputHash: input.inputHash,
            outputHash: input.outputHash,
            modelPayload: input.modelPayload,
            ...(input.canonicalHash !== undefined ? { canonicalHash: input.canonicalHash } : {}),
            updatedAt: input.updatedAt,
          })
          .where(
            and(
              eq(ingestionJob.tenantId, input.tenantId),
              eq(ingestionJob.ingestionJobId, input.jobId),
            ),
          );
      });
    },

    insertSourceDocument(input: SourceDocumentWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(sourceDocument).values({
          sourceDocumentId: input.documentId,
          tenantId: input.tenantId,
          ingestionJobId: input.jobId,
          fileName: input.fileName,
          mediaType: input.mediaType,
          byteLength: input.byteLength,
          sha256: input.sha256,
          parserId: input.parserId,
          status: input.status,
          error: input.error,
          parseIssues: [...input.parseIssues],
          statementKinds: input.statementKinds,
          createdAt: input.createdAt,
        });
      });
    },

    listSourceDocuments(tenantId: string, jobId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(sourceDocument)
          .where(
            and(eq(sourceDocument.tenantId, tenantId), eq(sourceDocument.ingestionJobId, jobId)),
          );
        return rows.map((row) => ({
          documentId: row.sourceDocumentId,
          jobId: row.ingestionJobId,
          fileName: row.fileName,
          mediaType: row.mediaType,
          byteLength: row.byteLength,
          sha256: row.sha256,
          parserId: row.parserId,
          status: row.status,
          error: row.error,
          parseIssues: parseIssueList(row.parseIssues),
          statementKinds: row.statementKinds,
        }));
      });
    },

    insertExtractedValues(tenantId: string, jobId: string, values: readonly ExtractedValueWrite[]) {
      return tenantTx(db, tenantId, async (tx) => {
        if (values.length === 0) return;
        await tx.insert(extractedValue).values(
          values.map((value) => ({
            extractedValueId: value.valueId,
            tenantId,
            ingestionJobId: jobId,
            sourceDocumentId: value.documentId,
            statementType: value.statementType,
            role: value.role,
            label: value.label,
            periodKey: value.periodKey,
            periodStart: value.periodStart,
            periodEnd: value.periodEnd,
            spanMonths: value.spanMonths,
            currency: value.currency,
            scale: value.scale,
            amountMinor: value.amountMinor,
            rawText: value.rawText,
            page: value.page,
            sheet: value.sheet,
            rowNo: value.rowNo,
            colNo: value.colNo,
            bbox: value.bbox,
            accountCode: value.accountCode,
            mappingConfidence: value.mappingConfidence,
            mappingMethod: value.mappingMethod,
            mappingAccepted: value.mappingAccepted,
            contra: value.contra,
            balanceKind: value.balanceKind,
            sortOrder: value.sortOrder,
            sectionId: value.sectionId,
          })),
        );
      });
    },

    listExtractedValues(tenantId: string, jobId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(extractedValue)
          .where(
            and(eq(extractedValue.tenantId, tenantId), eq(extractedValue.ingestionJobId, jobId)),
          );
        return rows.map(mapValue);
      });
    },

    updateExtractedValue(input: {
      tenantId: string;
      valueId: string;
      amountMinor?: string;
      accountCode?: string | null;
      mappingConfidence?: string | null;
      mappingMethod?: string | null;
      mappingAccepted?: boolean;
      contra?: boolean;
    }) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx
          .update(extractedValue)
          .set({
            ...(input.amountMinor !== undefined ? { amountMinor: input.amountMinor } : {}),
            ...(input.accountCode !== undefined ? { accountCode: input.accountCode } : {}),
            ...(input.mappingConfidence !== undefined
              ? { mappingConfidence: input.mappingConfidence }
              : {}),
            ...(input.mappingMethod !== undefined ? { mappingMethod: input.mappingMethod } : {}),
            ...(input.mappingAccepted !== undefined
              ? { mappingAccepted: input.mappingAccepted }
              : {}),
            ...(input.contra !== undefined ? { contra: input.contra } : {}),
          })
          .where(
            and(
              eq(extractedValue.tenantId, input.tenantId),
              eq(extractedValue.extractedValueId, input.valueId),
            ),
          );
      });
    },

    insertAccountMappings(
      tenantId: string,
      jobId: string,
      mappings: readonly AccountMappingWrite[],
    ) {
      return tenantTx(db, tenantId, async (tx) => {
        if (mappings.length === 0) return;
        await tx.insert(ingestionAccountMapping).values(
          mappings.map((mapping) => ({
            accountMappingId: mapping.mappingId,
            tenantId,
            ingestionJobId: jobId,
            extractedValueId: mapping.valueId,
            accountCode: mapping.accountCode,
            confidence: mapping.confidence,
            method: mapping.method,
            accepted: mapping.accepted,
            createdAt: mapping.createdAt,
          })),
        );
      });
    },

    replaceOpenCheckExceptions(
      tenantId: string,
      jobId: string,
      exceptions: readonly IngestionExceptionWrite[],
    ) {
      return tenantTx(db, tenantId, async (tx) => {
        const existing = await tx
          .select()
          .from(ingestionException)
          .where(
            and(
              eq(ingestionException.tenantId, tenantId),
              eq(ingestionException.ingestionJobId, jobId),
              eq(ingestionException.status, "open"),
            ),
          );
        for (const row of existing) {
          await tx
            .delete(ingestionException)
            .where(eq(ingestionException.ingestionExceptionId, row.ingestionExceptionId));
        }
        if (exceptions.length === 0) return;
        await tx.insert(ingestionException).values(
          exceptions.map((exception) => ({
            ingestionExceptionId: exception.exceptionId,
            tenantId,
            ingestionJobId: jobId,
            sourceDocumentId: exception.documentId,
            type: exception.type,
            severity: exception.severity,
            message: exception.message,
            expectedValue: exception.expected,
            actualValue: exception.actual,
            diffValue: exception.diff,
            provenance: exception.provenance,
            status: exception.status,
            resolution: null,
            createdAt: exception.createdAt,
            updatedAt: exception.createdAt,
          })),
        );
      });
    },

    listIngestionExceptions(tenantId: string, jobId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ingestionException)
          .where(
            and(
              eq(ingestionException.tenantId, tenantId),
              eq(ingestionException.ingestionJobId, jobId),
            ),
          );
        return rows.map(mapException);
      });
    },

    getIngestionException(tenantId: string, exceptionId: string) {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(ingestionException)
          .where(
            and(
              eq(ingestionException.tenantId, tenantId),
              eq(ingestionException.ingestionExceptionId, exceptionId),
            ),
          );
        const row = rows[0];
        return row ? mapException(row) : null;
      });
    },

    resolveIngestionException(input: ExceptionResolutionWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx
          .update(ingestionException)
          .set({
            status: input.status,
            resolution: input.resolution,
            updatedAt: input.updatedAt,
          })
          .where(
            and(
              eq(ingestionException.tenantId, input.tenantId),
              eq(ingestionException.ingestionExceptionId, input.exceptionId),
            ),
          );
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },
  };
}

function parseIssueList(value: unknown): {
  code: string;
  message: string;
  raw: string;
  page: number | null;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || typeof record["code"] !== "string" || typeof record["message"] !== "string") {
      return [];
    }
    return [
      {
        code: record["code"],
        message: record["message"],
        raw: typeof record["raw"] === "string" ? record["raw"] : "",
        page: typeof record["page"] === "number" ? record["page"] : null,
      },
    ];
  });
}

function mapJob(row: typeof ingestionJob.$inferSelect) {
  return {
    jobId: row.ingestionJobId,
    tenantId: row.tenantId,
    entityId: row.legalEntityId,
    status: row.status,
    currency: row.currency,
    formulaVersion: row.formulaVersion,
    inputHash: row.inputHash,
    outputHash: row.outputHash,
    modelPayload: asRecord(row.modelPayload),
    idempotencyKey: row.idempotencyKey,
    contentHash: row.contentHash,
    canonicalHash: row.canonicalHash,
    actorId: row.actorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapValue(row: typeof extractedValue.$inferSelect) {
  return {
    valueId: row.extractedValueId,
    jobId: row.ingestionJobId,
    documentId: row.sourceDocumentId,
    statementType: row.statementType,
    role: row.role,
    label: row.label,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    spanMonths: row.spanMonths,
    currency: row.currency,
    scale: row.scale,
    amountMinor: row.amountMinor,
    rawText: row.rawText,
    page: row.page,
    sheet: row.sheet,
    rowNo: row.rowNo,
    colNo: row.colNo,
    bbox: asRecord(row.bbox),
    accountCode: row.accountCode,
    mappingConfidence: row.mappingConfidence,
    mappingMethod: row.mappingMethod,
    mappingAccepted: row.mappingAccepted,
    contra: row.contra,
    balanceKind: row.balanceKind,
    sortOrder: row.sortOrder,
    sectionId: row.sectionId,
  };
}

function mapException(row: typeof ingestionException.$inferSelect) {
  return {
    exceptionId: row.ingestionExceptionId,
    jobId: row.ingestionJobId,
    documentId: row.sourceDocumentId,
    type: row.type,
    severity: row.severity,
    message: row.message,
    expected: row.expectedValue,
    actual: row.actualValue,
    diff: row.diffValue,
    provenance: asRecord(row.provenance) ?? {},
    status: row.status,
    resolution: asRecord(row.resolution),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
