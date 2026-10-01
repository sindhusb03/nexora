import {
  accountSchema,
  bulkAcceptExceptions,
  canResolveIngestion,
  exceptionSchema,
  extractedValueSchema,
  extractionJobSchema,
  jobContextSchema,
  resolveException,
  sourceDocumentSchema,
  uploadFileSchema,
  validateUpload,
  type Exception,
  type ExtractedValue,
  type ExtractionJob,
  type IngestionResult,
  type Provenance,
  type ResolveRequest,
  type UploadRequest,
} from "@nexora/contracts";
import { z } from "zod";

import { buildDemoPack } from "./fixtures";
import type { IngestionClient } from "./types";

const READY_MS = 1_200;

const storedJobSchema = z.object({
  jobId: z.string().min(1),
  startedAt: z.number().int(),
  uploads: z.array(
    z.object({
      fileName: uploadFileSchema.shape.fileName,
      mediaType: uploadFileSchema.shape.mediaType,
      byteLength: uploadFileSchema.shape.byteLength,
    }),
  ),
  context: jobContextSchema,
  documents: z.array(sourceDocumentSchema),
  values: z.array(extractedValueSchema),
  exceptions: z.array(exceptionSchema),
  chart: z.array(accountSchema),
  idempotency: z.array(z.object({ key: z.string(), fingerprint: z.string() })),
});

type StoredJob = z.infer<typeof storedJobSchema>;

export interface MockStore {
  read(): readonly StoredJob[];
  write(jobs: readonly StoredJob[]): void;
}

export function memoryStore(): MockStore {
  let jobs: StoredJob[] = [];
  return {
    read: () => jobs,
    write: (next) => {
      jobs = [...next];
    },
  };
}

export function sessionStore(): MockStore {
  const key = "nexora.ingestion.mock.v2";
  return {
    read() {
      if (typeof sessionStorage === "undefined") return [];
      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return [];
        const parsed = z.array(storedJobSchema).safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? parsed.data : [];
      } catch {
        return [];
      }
    },
    write(jobs) {
      if (typeof sessionStorage === "undefined") return;
      sessionStorage.setItem(key, JSON.stringify(jobs));
    },
  };
}

function denyRole(roles: readonly string[]): IngestionResult<never> | null {
  if (canResolveIngestion(roles)) return null;
  return failure(
    "AUTH_SCOPE_DENIED",
    "Resolving an extraction exception requires the owner or controller role.",
  );
}

function failure(code: string, message: string, details: unknown = null): IngestionResult<never> {
  return { ok: false, error: { code, message, details } };
}

function phase(startedAt: number, now: number): ExtractionJob["status"] {
  const elapsed = now - startedAt;
  if (elapsed < 400) return "queued";
  if (elapsed < 800) return "extracting";
  if (elapsed < READY_MS) return "checking";
  return "ready";
}

function present(job: StoredJob, now: number): ExtractionJob {
  const status = phase(job.startedAt, now);
  const elapsed = now - job.startedAt;
  const percent = status === "ready" ? 100 : elapsed >= 800 ? 85 : elapsed >= 400 ? 55 : 20;
  const fileStatus = status === "ready" ? "extracted" : elapsed >= 400 ? "reading" : "pending";
  const blockingOpen = job.exceptions.filter(
    (item) => item.status === "open" && item.severity === "error",
  ).length;
  const latestResolution = job.exceptions.reduce<number>((latest, item) => {
    const stamp = item.resolution ? Date.parse(item.resolution.at) : Number.NaN;
    return Number.isFinite(stamp) ? Math.max(latest, stamp) : latest;
  }, job.startedAt);
  const updated =
    status === "ready" ? Math.max(job.startedAt + READY_MS, latestResolution) : job.startedAt;
  return extractionJobSchema.parse({
    id: job.jobId,
    status,
    createdAt: new Date(job.startedAt).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    context: job.context,
    documents: job.documents,
    uploads: job.uploads.map((file) => ({
      ...file,
      percent,
      status: fileStatus,
    })),
    chart: job.chart,
    summary:
      status === "ready"
        ? {
            valueCount: job.values.length,
            exceptionCount: job.exceptions.length,
            blockingOpen,
          }
        : null,
    error: null,
  });
}

function materialize(
  jobId: string,
): Omit<StoredJob, "jobId" | "startedAt" | "uploads" | "idempotency"> {
  const pack = structuredClone(buildDemoPack());
  const documentIds = new Map(
    pack.documents.map((document) => [document.id, `${jobId}_${document.id}`]),
  );
  const documents = pack.documents.map((document) => ({
    ...document,
    id: documentIds.get(document.id) ?? document.id,
    jobId,
  }));
  const rewrite = (item: Provenance): Provenance => ({
    ...item,
    documentId: documentIds.get(item.documentId) ?? item.documentId,
  });
  const values = pack.values.map((item) => ({
    ...item,
    id: `${jobId}_${item.id}`,
    jobId,
    documentId: documentIds.get(item.documentId) ?? item.documentId,
    provenance: rewrite(item.provenance),
  }));
  const valueIds = new Map(
    pack.values.map((item, index) => [item.id, values[index]?.id ?? item.id]),
  );
  const exceptions = pack.exceptions.map((item) => ({
    ...item,
    id: `${jobId}_${item.type}`,
    jobId,
    documentId: documentIds.get(item.documentId) ?? item.documentId,
    valueIds: item.valueIds.map((id) => valueIds.get(id) ?? id),
    provenance: item.provenance.map(rewrite),
  }));
  return { context: pack.context, documents, values, exceptions, chart: [...pack.chart] };
}

export function createMockIngestionClient(options?: {
  readonly now?: () => number;
  readonly store?: MockStore;
}): IngestionClient {
  const now = options?.now ?? (() => Date.now());
  const store = options?.store ?? memoryStore();

  function jobs(): StoredJob[] {
    return [...store.read()];
  }

  function save(next: readonly StoredJob[]): void {
    store.write(next);
  }

  function findJob(jobId: string): StoredJob | undefined {
    return jobs().find((job) => job.jobId === jobId);
  }

  return {
    async upload(
      input: UploadRequest,
      _csrfToken: string,
    ): Promise<IngestionResult<ExtractionJob>> {
      const files = validateUpload(input);
      if (!files.ok) return files;
      const startedAt = now();
      const jobId = `job_${startedAt.toString(36)}_${jobs().length + 1}`;
      const packed = materialize(jobId);
      const stored: StoredJob = {
        jobId,
        startedAt,
        uploads: files.value.map((file) => ({
          fileName: file.fileName,
          mediaType: file.mediaType,
          byteLength: file.byteLength,
        })),
        ...packed,
        idempotency: [],
      };
      save([...jobs(), stored]);
      return { ok: true, value: present(stored, now()) };
    },

    async getJob(jobId: string): Promise<IngestionResult<ExtractionJob>> {
      const job = findJob(jobId);
      if (!job) {
        return failure("INGESTION_JOB_NOT_FOUND", `Job ${jobId} was not found.`);
      }
      return { ok: true, value: present(job, now()) };
    },

    async getValues(jobId: string): Promise<IngestionResult<readonly ExtractedValue[]>> {
      const job = findJob(jobId);
      if (!job) return failure("INGESTION_JOB_NOT_FOUND", `Job ${jobId} was not found.`);
      if (phase(job.startedAt, now()) !== "ready") {
        return failure(
          "INGESTION_JOB_NOT_READY",
          "Values are available after extraction finishes.",
        );
      }
      return { ok: true, value: job.values };
    },

    async getExceptions(jobId: string): Promise<IngestionResult<readonly Exception[]>> {
      const job = findJob(jobId);
      if (!job) return failure("INGESTION_JOB_NOT_FOUND", `Job ${jobId} was not found.`);
      if (phase(job.startedAt, now()) !== "ready") {
        return failure(
          "INGESTION_JOB_NOT_READY",
          "Exceptions are available after extraction finishes.",
        );
      }
      return { ok: true, value: job.exceptions };
    },

    async resolve(exceptionId, request, actorId, roles) {
      const denied = denyRole(roles);
      if (denied) return denied;
      return mutate(exceptionId, request, actorId);
    },

    async bulkAccept(request, actorId, roles) {
      const denied = denyRole(roles);
      if (denied) return denied;
      const current = jobs();
      const index = current.findIndex((job) =>
        job.exceptions.some((item) => item.jobId === request.jobId),
      );
      const job = index >= 0 ? current[index] : undefined;
      if (!job) return failure("INGESTION_JOB_NOT_FOUND", `Job ${request.jobId} was not found.`);
      if (phase(job.startedAt, now()) !== "ready") {
        return failure("INGESTION_JOB_NOT_READY", "Exceptions are not ready to resolve.");
      }
      const print = JSON.stringify({ kind: "bulk", request });
      const prior = job.idempotency.find((item) => item.key === request.idempotencyKey);
      if (prior && prior.fingerprint !== print) {
        return failure(
          "INGESTION_IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for a different resolution.",
        );
      }
      if (prior) return { ok: true, value: job.exceptions };
      const resolved = bulkAcceptExceptions(
        job.exceptions,
        request,
        actorId,
        new Date(now()).toISOString(),
      );
      if (!resolved.ok) return resolved;
      const nextJob: StoredJob = {
        ...job,
        exceptions: [...resolved.value],
        idempotency: [...job.idempotency, { key: request.idempotencyKey, fingerprint: print }],
      };
      const next = current.slice();
      next[index] = nextJob;
      save(next);
      return { ok: true, value: nextJob.exceptions };
    },
  };

  async function mutate(
    exceptionId: string,
    request: ResolveRequest,
    actorId: string,
  ): Promise<IngestionResult<Exception>> {
    const current = jobs();
    const index = current.findIndex((job) =>
      job.exceptions.some((item) => item.id === exceptionId),
    );
    const job = index >= 0 ? current[index] : undefined;
    if (!job) {
      return failure("INGESTION_EXCEPTION_NOT_FOUND", `Exception ${exceptionId} was not found.`);
    }
    if (phase(job.startedAt, now()) !== "ready") {
      return failure("INGESTION_JOB_NOT_READY", "Exceptions are not ready to resolve.");
    }
    const print = JSON.stringify({ kind: "resolve", exceptionId, request });
    const prior = job.idempotency.find((item) => item.key === request.idempotencyKey);
    const target = job.exceptions.find((item) => item.id === exceptionId);
    if (!target) {
      return failure("INGESTION_EXCEPTION_NOT_FOUND", `Exception ${exceptionId} was not found.`);
    }
    if (prior && prior.fingerprint !== print) {
      return failure(
        "INGESTION_IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used for a different resolution.",
      );
    }
    if (prior) return { ok: true, value: target };
    if (request.action === "remap") {
      const document = job.documents.find((item) => item.id === target.documentId);
      const account = job.chart.find(
        (item) => item.code === request.accountCode && item.entityName === document?.entityName,
      );
      if (!account) {
        return failure(
          "INGESTION_VALIDATION_FAILED",
          "That account is not on the chart for this entity.",
        );
      }
    }
    const resolved = resolveException(target, request, actorId, new Date(now()).toISOString());
    if (!resolved.ok) return resolved;
    const nextJob: StoredJob = {
      ...job,
      exceptions: job.exceptions.map((item) => (item.id === exceptionId ? resolved.value : item)),
      idempotency: [...job.idempotency, { key: request.idempotencyKey, fingerprint: print }],
    };
    const next = current.slice();
    next[index] = nextJob;
    save(next);
    return { ok: true, value: resolved.value };
  }
}
