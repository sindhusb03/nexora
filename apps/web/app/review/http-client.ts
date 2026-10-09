import {
  apiExceptionSchema,
  apiExtractedValueSchema,
  ingestionJobSchema,
  ingestionPaths,
  readApiError,
  resolveExceptionSchema,
  BULK_ACCEPT_MIN_CONFIDENCE,
  mediaTypeForFileName,
  type IngestionResult,
  type ExtractionJob,
  type ExtractedValue,
  type Exception,
  type Provenance,
  type IngestionJobResponse,
  type ExtractedValueResponse,
  type IngestionExceptionResponse,
} from "@nexora/contracts";
import { lookupCurrencyScale } from "@nexora/currency";
import { z } from "zod";
import type { IngestionClient } from "./types";

const valuesSchema = z.object({ values: z.array(apiExtractedValueSchema) });
const exceptionsSchema = z.object({ exceptions: z.array(apiExceptionSchema) });
const resolvedSchema = z.object({
  exceptionId: z.string(),
  status: z.string(),
  job: ingestionJobSchema,
});
const acceptedSchema = z.object({ jobId: z.string(), accepted: z.number().int() });

function invalid(message: string): IngestionResult<never> {
  return { ok: false, error: { code: "INGESTION_VALIDATION_FAILED", message, details: null } };
}
function requireCsrf(csrfToken: string): IngestionResult<never> | null {
  return csrfToken.trim()
    ? null
    : {
        ok: false,
        error: {
          code: "AUTH_CSRF_FAILED",
          message: "A cookie-authenticated write needs x-csrf-token.",
          details: null,
        },
      };
}
function provenance(documentId: string, source: ExtractedValueResponse["provenance"]): Provenance {
  return {
    ...source,
    documentId,
    bbox: source.bbox
      ? {
          x: source.bbox.x0,
          y: source.bbox.y0,
          width: source.bbox.x1 - source.bbox.x0,
          height: source.bbox.y1 - source.bbox.y0,
        }
      : null,
  };
}
const statements: Record<string, ExtractedValue["statement"]> = {
  income_statement: "income",
  balance_sheet: "balance",
  cash_flow: "cash",
  cash_flow_statement: "cash",
  bank: "bank",
  tax: "tax",
};

/** Validate the API wire contract, then adapt it to the review presentation types. */
export function createHttpIngestionClient(baseUrl: string): IngestionClient {
  const root = baseUrl.replace(/\/$/, "");
  const jobs = new Map<string, IngestionJobResponse>();
  const values = new Map<string, ExtractedValueResponse[]>();
  const exceptions = new Map<string, IngestionExceptionResponse>();

  function mapJob(job: IngestionJobResponse): ExtractionJob {
    jobs.set(job.jobId, job);
    const currency = job.currency ?? "";
    const available = values.get(job.jobId) ?? [];
    return {
      id: job.jobId,
      // The legacy UI type has no posted/needs_review members. Keep both terminal
      // states readable, and preserve the exact API status in context.basis.
      status:
        job.status === "needs_review" || job.status === "posted"
          ? "ready"
          : job.status === "mapping" || job.status === "validating" || job.status === "building"
            ? "checking"
            : job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      context: {
        asOf:
          available.find((v) => v.periodEnd)?.periodEnd?.slice(0, 10) ?? job.updatedAt.slice(0, 10),
        basis: job.status,
        disclaimer:
          "Resolutions are applied by the ingestion engine, which may post after validation.",
      },
      documents: job.documents.map((d) => ({
        id: d.documentId,
        jobId: job.jobId,
        fileName: d.fileName,
        mediaType: mediaTypeForFileName(d.fileName) ?? "text/csv",
        pageCount: null,
        sheetNames: [],
        regionHint: null,
        currency,
        entityName: job.entityId,
        pdfBase64: null,
      })),
      uploads: job.documents.map((d) => ({
        fileName: d.fileName,
        mediaType: mediaTypeForFileName(d.fileName) ?? "text/csv",
        byteLength: 0,
        percent: d.status === "parsed" || d.status === "failed" ? 100 : 0,
        status: d.status === "parsed" ? "extracted" : d.status,
      })),
      chart: [
        ...new Set(available.map((v) => v.accountCode).filter((v): v is string => v !== null)),
      ].map((code) => ({
        code,
        name: code.replaceAll("_", " "),
        currency,
        entityName: job.entityId,
      })),
      summary: {
        valueCount: job.counts.values,
        exceptionCount: job.counts.exceptionsOpen,
        blockingOpen: job.counts.exceptionsError,
      },
      error:
        job.status === "failed"
          ? {
              code: "INGESTION_VALIDATION_FAILED",
              message:
                job.documents.find((d) => d.error)?.error ??
                "Ingestion failed. Check the source files.",
              details: null,
            }
          : null,
    };
  }
  function mapValue(jobId: string, value: ExtractedValueResponse): ExtractedValue {
    return {
      id: value.valueId,
      jobId,
      documentId: value.documentId,
      label: value.label,
      statement: statements[value.statementType] ?? "income",
      periodLabel: value.periodKey ?? value.periodEnd,
      amountMinor: value.minor,
      currency: value.currency ?? jobs.get(jobId)?.currency ?? "",
      provenance: provenance(value.documentId, value.provenance),
      sheetWindow: null,
    };
  }
  function mapException(item: IngestionExceptionResponse): Exception & { apiType: string } {
    exceptions.set(item.id, item);
    const linked = values.get(item.jobId)?.find((v) => v.valueId === item.provenance.valueIds[0]);
    const documentId = item.documentId ?? linked?.documentId ?? "";
    const action: NonNullable<Exception["resolution"]>["action"] =
      item.status === "corrected"
        ? "correct"
        : item.status === "remapped"
          ? "remap"
          : item.status === "not_applicable"
            ? "not_applicable"
            : "accept";
    const resolution = item.resolution ? { ...item.resolution, action } : null;
    return {
      id: item.id,
      // Preserve the server category for HTTP bulk eligibility.
      apiType: item.type,
      jobId: item.jobId,
      documentId,
      valueIds: item.provenance.valueIds,
      // API-only check names stay visible in the message; the closest legacy
      // category keeps the existing queue filters usable.
      type:
        item.type === "mapping_low_confidence"
          ? "low_confidence_extraction"
          : (item.type as Exception["type"]),
      severity: item.severity,
      message: item.message,
      values: {
        ...item.values,
        currency: linked?.currency ?? jobs.get(item.jobId)?.currency ?? "",
      },
      confidence: linked?.mappingConfidence ?? "0",
      mappedAccount: linked?.accountCode ?? null,
      provenance: item.provenance.locations.length
        ? item.provenance.locations.map((p) => provenance(documentId, p))
        : [
            {
              documentId,
              fileName:
                jobs.get(item.jobId)?.documents.find((d) => d.documentId === documentId)
                  ?.fileName ?? "Job-level check",
              page: null,
              sheet: null,
              row: null,
              col: null,
              bbox: null,
              rawText: item.message,
            },
          ],
      status: item.status,
      resolution,
      auditTrail: resolution ? [resolution] : [],
    };
  }
  async function loadContext(jobId: string): Promise<IngestionResult<null>> {
    const [job, listed] = await Promise.all([
      send(ingestionJobSchema, ingestionPaths.job(jobId)),
      send(valuesSchema, ingestionPaths.values(jobId)),
    ]);
    if (!job.ok) return job;
    if (!listed.ok) return listed;
    jobs.set(jobId, job.value);
    values.set(jobId, listed.value.values);
    return { ok: true, value: null };
  }
  const client: IngestionClient = {
    async upload(input, csrfToken) {
      const blocked = requireCsrf(csrfToken);
      if (blocked) return blocked;
      const entityId = "entityId" in input ? input.entityId : undefined;
      if (!z.uuid().safeParse(entityId).success)
        return invalid(
          "The active company has no entity available for upload. Open Studio to configure it.",
        );
      const body = new FormData();
      body.set("entityId", String(entityId));
      try {
        for (const file of input.files) {
          const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
          body.append("files", new Blob([bytes], { type: file.mediaType }), file.fileName);
        }
      } catch {
        return invalid("The upload contains invalid file data.");
      }
      const result = await send(
        ingestionJobSchema,
        ingestionPaths.uploads,
        { method: "POST", body },
        input.idempotencyKey,
        csrfToken,
      );
      return result.ok ? { ok: true, value: mapJob(result.value) } : result;
    },
    async getJob(jobId) {
      const result = await send(ingestionJobSchema, ingestionPaths.job(jobId));
      if (!result.ok) return result;
      if (result.value.status === "needs_review" || result.value.status === "posted") {
        const listed = await send(valuesSchema, ingestionPaths.values(jobId));
        if (!listed.ok) return listed;
        values.set(jobId, listed.value.values);
      }
      return { ok: true, value: mapJob(result.value) };
    },
    async getValues(jobId) {
      const result = await send(valuesSchema, ingestionPaths.values(jobId));
      if (!result.ok) return result;
      values.set(jobId, result.value.values);
      return { ok: true, value: result.value.values.map((v) => mapValue(jobId, v)) };
    },
    async getExceptions(jobId) {
      const context = await loadContext(jobId);
      if (!context.ok) return context;
      const result = await send(exceptionsSchema, ingestionPaths.exceptions(jobId));
      return result.ok ? { ok: true, value: result.value.exceptions.map(mapException) } : result;
    },
    async resolve(exceptionId, request, _actorId, _roles, csrfToken) {
      const blocked = requireCsrf(csrfToken);
      if (blocked) return blocked;
      const original = exceptions.get(exceptionId);
      const note = request.note?.trim();
      if (!note) return invalid("Add a reviewer note before confirming.");
      const linked =
        original &&
        values.get(original.jobId)?.find((v) => original.provenance.valueIds.includes(v.valueId));
      let amount: string | undefined;
      if (request.action === "correct") {
        if (!linked?.currency || !/^-?\d+$/.test(request.correctedMinor ?? ""))
          return invalid("Load the extracted value before correcting its minor units.");
        const currency = lookupCurrencyScale(linked.currency);
        if (!currency.ok)
          return invalid(
            currency.reason === "invalid"
              ? "This currency code isn't valid, so the amount can't be corrected here. Check the currency on the extracted value."
              : "This currency has no minor units, so the amount can't be corrected here.",
          );
        const digits = currency.scale;
        const scaleDigits: Record<string, number> = {
          units: 0,
          thousands: 3,
          millions: 6,
          lakhs: 5,
          crores: 7,
        };
        const scale = scaleDigits[linked.scale];
        if (scale === undefined) return invalid("The extracted value has an unsupported scale.");
        const minor = request.correctedMinor!;
        const negative = minor.startsWith("-");
        const places = digits + scale;
        const absolute = minor.replace(/^-/, "").padStart(places + 1, "0");
        amount = `${negative ? "-" : ""}${places ? `${absolute.slice(0, -places)}.${absolute.slice(-places)}` : absolute}`;
      }
      const parsed = resolveExceptionSchema.safeParse({
        action: request.action,
        note,
        ...(amount !== undefined ? { amount } : {}),
        ...(request.action === "remap" ? { accountCode: request.accountCode } : {}),
      });
      if (!parsed.success)
        return invalid("A resolution needs a valid amount or lowercase snake case account code.");
      const result = await send(
        resolvedSchema,
        ingestionPaths.resolve(exceptionId),
        { method: "POST", body: JSON.stringify(parsed.data) },
        request.idempotencyKey,
        csrfToken,
      );
      if (!result.ok) return result;
      mapJob(result.value.job);
      const listed = await client.getExceptions(result.value.job.jobId);
      if (!listed.ok) return listed;
      const found = listed.value.find((item) => item.id === exceptionId);
      return found
        ? { ok: true, value: found }
        : invalid("The resolved exception was not returned by the API.");
    },
    async bulkAccept(request, _actorId, _roles, csrfToken) {
      const blocked = requireCsrf(csrfToken);
      if (blocked) return blocked;
      const result = await send(
        acceptedSchema,
        ingestionPaths.bulkAccept,
        {
          method: "POST",
          body: JSON.stringify({ jobId: request.jobId, minConfidence: BULK_ACCEPT_MIN_CONFIDENCE }),
        },
        request.idempotencyKey,
        csrfToken,
      );
      return result.ok ? client.getExceptions(result.value.jobId) : result;
    },
  };
  return client;

  async function send<T>(
    schema: z.ZodType<T>,
    path: string,
    init?: RequestInit,
    idempotencyKey?: string,
    csrfToken?: string,
  ): Promise<IngestionResult<T>> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (init?.body !== undefined && !(init.body instanceof FormData))
      headers.set("content-type", "application/json");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
    try {
      const response = await fetch(`${root}${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = readApiError(body);
        return error
          ? { ok: false, error }
          : {
              ok: false,
              error: {
                code: "INGESTION_VALIDATION_FAILED",
                message: "Ingestion API returned an unreadable error.",
                details: null,
              },
            };
      }
      const parsed = schema.safeParse(body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error: {
              code: "INGESTION_VALIDATION_FAILED",
              message: "Ingestion API returned an unexpected payload.",
              details: null,
            },
          };
    } catch {
      return {
        ok: false,
        error: {
          code: "INGESTION_UNAVAILABLE",
          message: "Ingestion API is unreachable.",
          details: null,
        },
      };
    }
  }
}
