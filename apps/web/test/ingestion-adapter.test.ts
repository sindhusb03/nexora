// @vitest-environment node
import {
  EXCEPTION_TYPES,
  HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
  exceptionSchema,
  isBulkCandidate,
} from "@nexora/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getIngestionClient, resetIngestionClient } from "../app/review/client";

import { buildDemoPack } from "../app/review/fixtures";
import { createHttpIngestionClient } from "../app/review/http-client";
import { createMockIngestionClient, memoryStore } from "../app/review/mock-client";
import { buildSimplePdf } from "../app/review/simple-pdf";

const csrf = "csrf-test-token";
const roles = ["controller"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetIngestionClient();
});

const csv = {
  fileName: "nazareno-income.csv",
  mediaType: "text/csv" as const,
  byteLength: 1,
  contentBase64: "QQ==",
};

function clientAt(start: number) {
  let clock = start;
  const ingestion = createMockIngestionClient({
    now: () => clock,
    store: memoryStore(),
  });
  return {
    ingestion,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("header adapter rejection", () => {
  it.each(["expected", "actual", "diff"] as const)(
    "preserves the HTTP 422 envelope for a non-null header %s and leaves adapter state unchanged",
    async (field) => {
      let clock = 0;
      const store = memoryStore();
      const client = createMockIngestionClient({ now: () => clock, store });
      const uploaded = await client.upload({ files: [csv], idempotencyKey: "header-upload" }, csrf);
      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) return;
      clock = 2_000;
      store.write(
        store.read().map((job) => ({
          ...job,
          exceptions: job.exceptions.map((item) =>
            item.type === "header_as_value"
              ? {
                  ...item,
                  values: {
                    expected: null,
                    actual: null,
                    diff: null,
                    currency: "USD",
                    [field]: "0",
                  },
                }
              : item,
          ),
        })),
      );
      const listed = await client.getExceptions(uploaded.value.id);
      if (!listed.ok) throw new Error(listed.error.message);
      const header = listed.value.find((item) => item.type === "header_as_value")!;
      const before = structuredClone(store.read());
      const request = {
        action: "accept" as const,
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "header-accept",
      };
      const rejected = await client.resolve(header.id, request, "sindhu", roles, csrf);
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: "HEADER_VALUE_NOT_ACCEPTABLE",
          message: HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
          details: { httpStatus: 422 },
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          expect(url).toBe(`https://ingestion.test/ingestion/exceptions/${header.id}/resolve`);
          expect(init.method).toBe("POST");
          expect(JSON.parse(String(init.body))).toEqual({
            action: "accept",
            note: "Reviewed: accept",
          });
          const result = await client.resolve(header.id, request, "sindhu", roles, csrf);
          if (result.ok) throw new Error("Expected rejection");
          const details = result.error.details as { httpStatus: number };
          return new Response(
            JSON.stringify({ error: { code: result.error.code, message: result.error.message } }),
            { status: details.httpStatus },
          );
        }),
      );
      const http = createHttpIngestionClient("https://ingestion.test");
      expect(await http.resolve(header.id, request, "sindhu", roles, csrf)).toMatchObject({
        ok: false,
        error: {
          code: "HEADER_VALUE_NOT_ACCEPTABLE",
          message: HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
        },
      });
      expect(store.read()).toEqual(before);
      expect(await client.getExceptions(uploaded.value.id)).toEqual(listed);
    },
  );

  it.each(["header_with_value", "low_confidence_extraction", "missing_period"])(
    "rejects mixed bulk requests containing %s without any audit entries",
    async (excludedId) => {
      let clock = 0;
      const store = memoryStore();
      const client = createMockIngestionClient({ now: () => clock, store });
      const uploaded = await client.upload({ files: [csv], idempotencyKey: "bulk-upload" }, csrf);
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      clock = 2_000;
      store.write(
        store.read().map((job) => ({
          ...job,
          exceptions: job.exceptions.map((item) =>
            item.type === "low_confidence_extraction" ? { ...item, confidence: "0.9900" } : item,
          ),
        })),
      );
      const before = structuredClone(store.read());
      const jobId = uploaded.value.id;
      const request = {
        jobId,
        exceptionIds: [`${jobId}_header_as_value`, `${jobId}_${excludedId}`],
        note: null,
        idempotencyKey: "bulk-rejected",
      };
      expect(await client.bulkAccept(request, "sindhu", roles, csrf)).toMatchObject({
        ok: false,
        error: { code: "INGESTION_BULK_REJECTED" },
      });
      expect(store.read()).toEqual(before);
      const accepted = await client.bulkAccept(
        { ...request, exceptionIds: [`${jobId}_header_as_value`], idempotencyKey: "bulk-eligible" },
        "sindhu",
        roles,
        csrf,
      );
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.value.find((item) => item.id === `${jobId}_header_as_value`)).toMatchObject({
        status: "accepted",
        auditTrail: [expect.objectContaining({ action: "accept" })],
      });
      expect(accepted.value.find((item) => item.id === `${jobId}_${excludedId}`)).toMatchObject({
        status: "open",
        resolution: null,
        auditTrail: [],
      });
    },
  );
});

describe("demo extraction fixture", () => {
  it("covers every check type in India and the US without recomputed diffs", () => {
    const pack = buildDemoPack();
    expect(pack.documents.map((document) => document.regionHint).sort()).toEqual([
      "IN",
      "IN",
      "IN",
      "US",
      "US",
      "US",
    ]);
    expect([...new Set(pack.exceptions.map((item) => item.type))].sort()).toEqual(
      [...EXCEPTION_TYPES].sort(),
    );
    for (const item of pack.exceptions) {
      expect(exceptionSchema.parse(item).id).toBe(item.id);
      if (item.values.expected !== null && item.values.actual !== null) {
        expect((BigInt(item.values.actual) - BigInt(item.values.expected)).toString()).toBe(
          item.values.diff,
        );
      } else {
        expect(item.values.diff).toBeNull();
      }
      const sheet = pack.values.find((value) => value.id === item.valueIds[0])?.sheetWindow;
      if (sheet) {
        const row = sheet.highlightRow - sheet.originRow;
        const col = sheet.highlightCol - sheet.originCol;
        expect(sheet.cells[row]?.[col]).toBeDefined();
      }
    }
    expect(buildSimplePdf(["Cash"]).startsWith("JVBER")).toBe(true);
    const bank = pack.values.find((value) => value.id === "bank_end");
    expect(bank?.amountMinor).toBe("4800000");
    expect(bank?.provenance.rawText).toBe("Ending balance 48,000.00");
    expect(pack.documents.find((document) => document.id === "mer_bs")?.pageCount).toBe(2);
    expect(
      pack.exceptions.find((item) => item.type === "balance_sheet_equation")?.provenance[0]?.page,
    ).toBe(2);
    expect(pack.exceptions.find((item) => item.type === "sign_convention")?.mappedAccount).toBe(
      "6100",
    );
  });
});

describe("mock ingestion client", () => {
  it("rejects an unsupported file and an empty file", async () => {
    const { ingestion } = clientAt(1_700_000_000_000);
    const bad = await ingestion.upload(
      {
        files: [{ ...csv, fileName: "notes.txt", mediaType: "text/csv" }],
        idempotencyKey: "idem-upload-bad",
      },
      csrf,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INGESTION_UNSUPPORTED_FILE");

    const empty = await ingestion.upload(
      {
        files: [{ ...csv, fileName: "blank.csv", byteLength: 0, contentBase64: "" }],
        idempotencyKey: "idem-upload-empty",
      },
      csrf,
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("INGESTION_EMPTY_UPLOAD");
  });

  it("polls to ready, then resolves and bulk-accepts without changing extracted amounts", async () => {
    const { ingestion, advance } = clientAt(1_700_000_000_000);
    const uploaded = await ingestion.upload(
      { files: [csv], idempotencyKey: "idem-upload-ready" },
      csrf,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect(uploaded.value.status).toBe("queued");
    const early = await ingestion.getExceptions(uploaded.value.id);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe("INGESTION_JOB_NOT_READY");

    advance(1_200);
    const ready = await ingestion.getJob(uploaded.value.id);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.value.status).toBe("ready");
    const listed = await ingestion.getExceptions(uploaded.value.id);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const balance = listed.value.find((item) => item.type === "balance_sheet_equation");
    const unmapped = listed.value.find((item) => item.type === "unmapped_account");
    expect(balance).toBeDefined();
    expect(unmapped).toBeDefined();
    if (!balance || !unmapped) return;

    const corrected = await ingestion.resolve(
      balance.id,
      {
        action: "correct",
        note: "Tie the balance sheet",
        correctedMinor: balance.values.expected,
        accountCode: null,
        idempotencyKey: "idem-correct-balance",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.status).toBe("corrected");
    expect(corrected.value.values).toEqual(balance.values);
    expect(corrected.value.auditTrail[0]?.by).toBe("sindhu");

    const replay = await ingestion.resolve(
      balance.id,
      {
        action: "correct",
        note: "Tie the balance sheet",
        correctedMinor: balance.values.expected,
        accountCode: null,
        idempotencyKey: "idem-correct-balance",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(replay.ok).toBe(true);

    const conflict = await ingestion.resolve(
      balance.id,
      {
        action: "accept",
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "idem-correct-balance",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("INGESTION_IDEMPOTENCY_CONFLICT");

    const wrongChart = await ingestion.resolve(
      unmapped.id,
      {
        action: "remap",
        note: null,
        correctedMinor: null,
        accountCode: "3100",
        idempotencyKey: "idem-wrong-chart",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(wrongChart.ok).toBe(false);

    const remapped = await ingestion.resolve(
      unmapped.id,
      {
        action: "remap",
        note: "Map implementation fees to service revenue",
        correctedMinor: null,
        accountCode: "4000",
        idempotencyKey: "idem-remap-fees",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(remapped.ok).toBe(true);
    if (!remapped.ok) return;
    expect(remapped.value.resolution?.before).toBeNull();
    expect(remapped.value.resolution?.after).toBe("4000");
    expect(remapped.value.values.actual).toBe(unmapped.values.actual);

    const again = await ingestion.resolve(
      remapped.value.id,
      {
        action: "accept",
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "idem-second",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("INGESTION_INVALID_TRANSITION");

    const current = await ingestion.getExceptions(uploaded.value.id);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const eligible = current.value.filter((item) => isBulkCandidate(item));
    expect(eligible.map((item) => item.type)).toEqual(["header_as_value"]);
    expect(eligible.map((item) => item.type)).not.toContain("duplicate_extraction");
    expect(eligible.map((item) => item.type)).not.toContain("unit_scale");
    expect(eligible.map((item) => item.type)).not.toContain("sign_convention");
    const bulk = await ingestion.bulkAccept(
      {
        jobId: uploaded.value.id,
        exceptionIds: eligible.map((item) => item.id),
        note: "High confidence",
        idempotencyKey: "idem-bulk-1",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(
      bulk.value.filter((item) => item.severity === "error" && item.status === "open"),
    ).toHaveLength(0);
    const low = bulk.value.find((item) => item.type === "low_confidence_extraction");
    expect(low?.status).toBe("open");
  });

  it("keeps a partial bulk accept from applying", async () => {
    const { ingestion, advance } = clientAt(1_700_000_000_000);
    const uploaded = await ingestion.upload(
      { files: [csv], idempotencyKey: "idem-upload-partial" },
      csrf,
    );
    if (!uploaded.ok) throw new Error("upload failed");
    advance(1_200);
    const listed = await ingestion.getExceptions(uploaded.value.id);
    if (!listed.ok) throw new Error("exceptions failed");
    const errorItem = listed.value.find((item) => item.severity === "error");
    const warn = listed.value.find((item) => item.type === "sign_convention");
    expect(errorItem && warn).toBeTruthy();
    if (!errorItem || !warn) return;
    const bulk = await ingestion.bulkAccept(
      {
        jobId: uploaded.value.id,
        exceptionIds: [errorItem.id, warn.id],
        note: null,
        idempotencyKey: "idem-bulk-reject",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(bulk.ok).toBe(false);
    const after = await ingestion.getExceptions(uploaded.value.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.find((item) => item.id === warn.id)?.status).toBe("open");
  });

  it("rejects a viewer and a platform admin who cannot resolve", async () => {
    const { ingestion, advance } = clientAt(1_700_000_000_000);
    const uploaded = await ingestion.upload(
      { files: [csv], idempotencyKey: "idem-upload-viewer" },
      csrf,
    );
    if (!uploaded.ok) throw new Error("upload failed");
    advance(1_200);
    const listed = await ingestion.getExceptions(uploaded.value.id);
    if (!listed.ok) throw new Error("exceptions failed");
    const target = listed.value[0];
    if (!target) throw new Error("missing exception");
    const viewer = await ingestion.resolve(
      target.id,
      {
        action: "accept",
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "idem-viewer",
      },
      "viewer",
      ["viewer"],
      csrf,
    );
    expect(viewer.ok).toBe(false);
    if (!viewer.ok) expect(viewer.error.code).toBe("AUTH_SCOPE_DENIED");
    const admin = await ingestion.bulkAccept(
      {
        jobId: uploaded.value.id,
        exceptionIds: [target.id],
        note: null,
        idempotencyKey: "idem-admin",
      },
      "platform-admin",
      ["platform-admin"],
      csrf,
    );
    expect(admin.ok).toBe(false);
    if (!admin.ok) expect(admin.error.code).toBe("AUTH_SCOPE_DENIED");
    const after = await ingestion.getExceptions(uploaded.value.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.find((item) => item.id === target.id)?.status).toBe("open");
  });
});

describe("http ingestion client", () => {
  const jobId = "00000000-0000-4000-8000-000000000001";
  const documentId = "00000000-0000-4000-8000-000000000002";
  const valueId = "00000000-0000-4000-8000-000000000003";
  const exceptionId = "00000000-0000-4000-8000-000000000004";
  const entityId = "00000000-0000-4000-8000-000000000005";
  const wireJob = {
    jobId,
    entityId,
    status: "needs_review",
    currency: "USD",
    formulaVersion: null,
    inputHash: null,
    outputHash: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    documents: [
      {
        documentId,
        fileName: csv.fileName,
        status: "parsed",
        statementKinds: ["income_statement"],
        error: null,
      },
    ],
    counts: {
      documents: 1,
      values: 1,
      exceptionsOpen: 1,
      exceptionsError: 0,
      exceptionsWarn: 1,
      exceptionsInfo: 0,
    },
  };
  const provenance = {
    fileName: csv.fileName,
    page: 1,
    sheet: null,
    row: 2,
    col: 3,
    bbox: { x0: 10, y0: 20, x1: 60, y1: 40 },
    rawText: "Revenue 123.45",
  };
  const wireValue = {
    valueId,
    documentId,
    statementType: "income_statement",
    role: "line",
    label: "Revenue",
    periodKey: "FY2025",
    periodEnd: "2025-12-31",
    currency: "USD",
    scale: "units",
    minor: "12345",
    accountCode: "revenue",
    mappingConfidence: "0.95",
    mappingMethod: "stub",
    mappingAccepted: false,
    provenance,
  };
  const wireException = {
    id: exceptionId,
    jobId,
    documentId,
    type: "mapping_low_confidence",
    severity: "warn",
    message: "Confirm mapping",
    values: { expected: null, actual: "12345", diff: null },
    provenance: { valueIds: [valueId], locations: [provenance] },
    status: "open",
    resolution: null,
  };
  function stub() {
    let current = wireException as typeof wireException & {
      resolution: null | { by: string; at: string; note: string; before: string; after: string };
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/resolve")) {
        current = {
          ...current,
          status: "accepted",
          resolution: {
            by: "reviewer",
            at: wireJob.updatedAt,
            note: "Reviewed",
            before: "12345",
            after: "12345",
          },
        };
        return Response.json({
          exceptionId,
          status: "accepted",
          job: { ...wireJob, status: "posted" },
        });
      }
      if (url.endsWith("/bulk-accept")) return Response.json({ jobId, accepted: 1 });
      if (url.endsWith("/values")) return Response.json({ jobId, values: [wireValue] });
      if (url.endsWith("/exceptions")) return Response.json({ jobId, exceptions: [current] });
      return Response.json(wireJob);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  it("uploads multipart bytes with entityId to the engine route", async () => {
    const fetchMock = stub();
    const http = createHttpIngestionClient("http://127.0.0.1:8787/");
    const input = {
      files: [csv, { ...csv, fileName: "second.csv" }],
      entityId,
      idempotencyKey: "upload-http",
    };
    expect((await http.upload(input, csrf)).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/ingestion/uploads");
    expect(init?.body).toBeInstanceOf(FormData);
    const body = init?.body as FormData;
    expect(body.get("entityId")).toBe(entityId);
    expect(body.getAll("files")).toHaveLength(2);
    const file = body.get("files") as File;
    expect(file.name).toBe(csv.fileName);
    expect(file.type).toBe("text/csv");
    expect(await file.text()).toBe("A");
    const headers = new Headers(init?.headers);
    expect(headers.has("content-type")).toBe(false);
    expect(headers.get("x-csrf-token")).toBe(csrf);
    expect(headers.get("idempotency-key")).toBe("upload-http");
    expect(init?.credentials).toBe("include");
  });
  it("maps jobs, values, exceptions and provenance without sample content", async () => {
    const fetchMock = stub();
    const http = createHttpIngestionClient("http://127.0.0.1:8787");
    const job = await http.getJob(jobId);
    expect(job).toMatchObject({
      ok: true,
      value: {
        id: jobId,
        context: { basis: "needs_review" },
        summary: { blockingOpen: 0, valueCount: 1 },
      },
    });
    const values = await http.getValues(jobId);
    expect(values).toMatchObject({
      ok: true,
      value: [
        {
          id: valueId,
          amountMinor: "12345",
          currency: "USD",
          statement: "income",
          sheetWindow: null,
          provenance: { documentId, bbox: { x: 10, y: 20, width: 50, height: 20 } },
        },
      ],
    });
    expect(await http.getExceptions(jobId)).toMatchObject({
      ok: true,
      value: [
        {
          id: exceptionId,
          valueIds: [valueId],
          confidence: "0.95",
          values: { currency: "USD", actual: "12345" },
          mappedAccount: "revenue",
          auditTrail: [],
        },
      ],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      `http://127.0.0.1:8787/ingestion/jobs/${jobId}/values`,
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      `http://127.0.0.1:8787/ingestion/jobs/${jobId}/exceptions`,
    );
    fetchMock.mockResolvedValueOnce(Response.json({ ...wireJob, status: "posted" }));
    expect(await http.getJob(jobId)).toMatchObject({
      ok: true,
      value: { context: { basis: "posted" } },
    });
  });
  it("sends decimal corrections, required notes and snake case accounts, then refetches", async () => {
    const fetchMock = stub();
    const http = createHttpIngestionClient("http://127.0.0.1:8787");
    await http.getExceptions(jobId);
    for (const [action, correctedMinor, accountCode, expected] of [
      ["correct", "-12345", null, { action: "correct", note: "Fix value", amount: "-123.45" }],
      [
        "remap",
        null,
        "accounts_receivable",
        { action: "remap", note: "Fix value", accountCode: "accounts_receivable" },
      ],
      ["accept", null, null, { action: "accept", note: "Reviewed: accept" }],
    ] as const) {
      const result = await http.resolve(
        exceptionId,
        {
          action,
          correctedMinor,
          accountCode,
          note: action === "accept" ? null : "Fix value",
          idempotencyKey: "resolve-http",
        },
        "actor",
        roles,
        csrf,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: "accepted",
          resolution: { action: "accept", by: "reviewer" },
          auditTrail: [expect.objectContaining({ by: "reviewer" })],
        },
      });
      const call = fetchMock.mock.calls.filter(([url]) => url.endsWith("/resolve")).at(-1)!;
      expect(call[0]).toBe(`http://127.0.0.1:8787/ingestion/exceptions/${exceptionId}/resolve`);
      expect(JSON.parse(String(call[1]?.body))).toEqual(expected);
      expect(new Headers(call[1]?.headers).get("x-csrf-token")).toBe(csrf);
    }
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("/exceptions");
  });
  it("sends jobId and minConfidence for bulk acceptance and refetches exceptions", async () => {
    const fetchMock = stub();
    const http = createHttpIngestionClient("http://127.0.0.1:8787");
    expect(
      (
        await http.bulkAccept(
          { jobId, exceptionIds: [exceptionId], note: null, idempotencyKey: "bulk-http" },
          "actor",
          roles,
          csrf,
        )
      ).ok,
    ).toBe(true);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:8787/ingestion/exceptions/bulk-accept");
    expect(JSON.parse(String(call[1]?.body))).toEqual({ jobId, minConfidence: "0.9000" });
    expect(new Headers(call[1]?.headers).get("idempotency-key")).toBe("bulk-http");
  });
  it("fails closed for missing entity or csrf and surfaces server/network/invalid responses", async () => {
    const fetchMock = stub();
    const http = createHttpIngestionClient("http://127.0.0.1:8787");
    expect(await http.upload({ files: [csv], idempotencyKey: "upload-http" }, csrf)).toMatchObject({
      ok: false,
      error: { code: "INGESTION_VALIDATION_FAILED" },
    });
    expect(await http.upload({ files: [csv], idempotencyKey: "upload-http" }, " ")).toMatchObject({
      ok: false,
      error: { code: "AUTH_CSRF_FAILED" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: "AUTH_SCOPE_DENIED", message: "Denied" } }, { status: 403 }),
    );
    expect(await http.getJob(jobId)).toMatchObject({
      ok: false,
      error: { code: "AUTH_SCOPE_DENIED" },
    });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await http.getJob(jobId)).toMatchObject({
      ok: false,
      error: { code: "INGESTION_UNAVAILABLE" },
    });
    fetchMock.mockResolvedValueOnce(Response.json({ wrong: true }));
    expect(await http.getJob(jobId)).toMatchObject({
      ok: false,
      error: { code: "INGESTION_VALIDATION_FAILED" },
    });
  });
});

describe("ingestion client selection", () => {
  it.each([undefined, "http", "unexpected"])("uses HTTP for mode %s", async (mode) => {
    vi.stubEnv("NEXT_PUBLIC_INGESTION_MODE", mode);
    resetIngestionClient();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { error: { code: "API_PROBE", message: "Real HTTP request" } },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await getIngestionClient().getJob("probe")).toMatchObject({
      ok: false,
      error: { code: "API_PROBE" },
    });
    expect(fetchMock).toHaveBeenCalled();
  });
  it.each(["mock", "demo"])("uses fixtures only for explicit %s mode", async (mode) => {
    vi.stubEnv("NEXT_PUBLIC_INGESTION_MODE", mode);
    resetIngestionClient();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await getIngestionClient().upload({ files: [csv], idempotencyKey: "demo-upload" }, csrf)).ok,
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
