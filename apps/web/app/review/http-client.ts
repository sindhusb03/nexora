import {
  bulkAcceptRequestSchema,
  exceptionSchema,
  extractedValueSchema,
  extractionJobSchema,
  ingestionPaths,
  readApiError,
  type IngestionResult,
} from "@nexora/contracts";
import { z } from "zod";

import type { IngestionClient } from "./types";

const valuesSchema = z.object({ values: z.array(extractedValueSchema) });
const exceptionsSchema = z.object({ exceptions: z.array(exceptionSchema) });

function requireCsrf(csrfToken: string): IngestionResult<never> | null {
  if (csrfToken.trim().length > 0) return null;
  return {
    ok: false,
    error: {
      code: "AUTH_CSRF_FAILED",
      message: "A cookie-authenticated write needs x-csrf-token.",
      details: null,
    },
  };
}

/**
 * HTTP adapter. Actor id and roles are intentionally unused: the API resolves
 * both from the session cookie and must ignore any client-supplied actor.
 * Cookie writes send `x-csrf-token` and fail closed when it is missing.
 */
export function createHttpIngestionClient(baseUrl: string): IngestionClient {
  const root = baseUrl.replace(/\/$/, "");

  return {
    upload(input, csrfToken) {
      const blocked = requireCsrf(csrfToken);
      if (blocked) return Promise.resolve(blocked);
      return send(
        extractionJobSchema,
        ingestionPaths.uploads,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        input.idempotencyKey,
        csrfToken,
      );
    },
    getJob(jobId) {
      return send(extractionJobSchema, ingestionPaths.job(jobId));
    },
    async getValues(jobId) {
      const result = await send(valuesSchema, ingestionPaths.values(jobId));
      return result.ok ? { ok: true, value: result.value.values } : result;
    },
    async getExceptions(jobId) {
      const result = await send(exceptionsSchema, ingestionPaths.exceptions(jobId));
      return result.ok ? { ok: true, value: result.value.exceptions } : result;
    },
    resolve(exceptionId, request, _actorId, _roles, csrfToken) {
      const blocked = requireCsrf(csrfToken);
      if (blocked) return Promise.resolve(blocked);
      return send(
        exceptionSchema,
        ingestionPaths.resolve(exceptionId),
        {
          method: "POST",
          body: JSON.stringify(request),
        },
        request.idempotencyKey,
        csrfToken,
      );
    },
    async bulkAccept(request, _actorId, _roles, csrfToken) {
      const blocked = requireCsrf(csrfToken);
      if (blocked) return blocked;
      const parsed = bulkAcceptRequestSchema.safeParse(request);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "INGESTION_VALIDATION_FAILED",
            message: "Bulk accept payload is invalid.",
            details: null,
          },
        };
      }
      const result = await send(
        exceptionsSchema,
        ingestionPaths.bulkAccept,
        {
          method: "POST",
          body: JSON.stringify(parsed.data),
        },
        parsed.data.idempotencyKey,
        csrfToken,
      );
      return result.ok ? { ok: true, value: result.value.exceptions } : result;
    },
  };

  async function send<T>(
    schema: z.ZodType<T>,
    path: string,
    init?: RequestInit,
    idempotencyKey?: string,
    csrfToken?: string,
  ): Promise<IngestionResult<T>> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (init?.body !== undefined) headers.set("content-type", "application/json");
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
