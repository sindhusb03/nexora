import { bulkAcceptSchema, exceptionQuerySchema, resolveExceptionSchema } from "@nexora/contracts";
import type { LedgerStore } from "@nexora/db";
import type { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../http.js";
import { readActor } from "../http.js";
import { stubMappingProposer, type MappingProposer } from "./proposer.js";
import { createIngestionService } from "./service.js";

export function registerIngestionRoutes(
  app: Hono<AppEnv>,
  options: {
    readonly store: LedgerStore;
    readonly platformAdminActorIds: readonly string[];
    readonly proposer?: MappingProposer;
  },
): void {
  const service = createIngestionService(
    options.store,
    options.platformAdminActorIds,
    options.proposer ?? stubMappingProposer(),
  );

  app.post("/ingestion/uploads", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    const entityId = z.uuid().parse(readField(body, "entityId"));
    const files = await readFiles(body);
    const result = await service.upload(readActor(c), { entityId, files });
    return c.json(result, 201);
  });

  app.get("/ingestion/jobs/:id", async (c) => {
    const jobId = z.uuid().parse(c.req.param("id"));
    return c.json(await service.getJob(readActor(c), jobId));
  });

  app.get("/ingestion/jobs/:id/values", async (c) => {
    const jobId = z.uuid().parse(c.req.param("id"));
    return c.json(await service.getValues(readActor(c), jobId));
  });

  app.get("/ingestion/jobs/:id/exceptions", async (c) => {
    const jobId = z.uuid().parse(c.req.param("id"));
    const severity = c.req.query("severity");
    const type = c.req.query("type");
    const documentId = c.req.query("documentId");
    const query = exceptionQuerySchema.parse({
      ...(severity ? { severity } : {}),
      ...(type ? { type } : {}),
      ...(documentId ? { documentId } : {}),
    });
    return c.json(
      await service.getExceptions(readActor(c), jobId, {
        ...(query.severity !== undefined ? { severity: query.severity } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
        ...(query.documentId !== undefined ? { documentId: query.documentId } : {}),
      }),
    );
  });

  app.post("/ingestion/exceptions/:id/resolve", async (c) => {
    const exceptionId = z.uuid().parse(c.req.param("id"));
    const body = resolveExceptionSchema.parse(await c.req.json());
    return c.json(
      await service.resolve(readActor(c), exceptionId, {
        action: body.action,
        note: body.note,
        ...(body.amount !== undefined ? { amount: body.amount } : {}),
        ...(body.accountCode !== undefined ? { accountCode: body.accountCode } : {}),
      }),
    );
  });

  app.post("/ingestion/exceptions/bulk-accept", async (c) => {
    const body = bulkAcceptSchema.parse(await c.req.json());
    return c.json(await service.bulkAccept(readActor(c), body));
  });
}

function readField(body: Record<string, unknown>, key: string): unknown {
  const value = body[key];
  return Array.isArray(value) ? value[0] : value;
}

async function readFiles(body: Record<string, unknown>) {
  const raw = body["file"] ?? body["files"];
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const files: { fileName: string; mediaType: string; bytes: Uint8Array }[] = [];
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    files.push({
      fileName: entry.name || "upload",
      mediaType: entry.type || "application/octet-stream",
      bytes: new Uint8Array(await entry.arrayBuffer()),
    });
  }
  return files;
}
