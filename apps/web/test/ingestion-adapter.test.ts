import {
  EXCEPTION_TYPES,
  HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
  exceptionSchema,
  isBulkCandidate,
  type Exception,
} from "@nexora/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDemoPack } from "../app/review/fixtures";
import { createHttpIngestionClient } from "../app/review/http-client";
import { createMockIngestionClient, memoryStore } from "../app/review/mock-client";
import { buildSimplePdf } from "../app/review/simple-pdf";

const csrf = "csrf-test-token";
const roles = ["controller"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
          expect(url).toBe(`https://ingestion.test/v1/ingestion/exceptions/${header.id}/resolve`);
          expect(init.method).toBe("POST");
          expect(JSON.parse(String(init.body))).toEqual(request);
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
  it("posts resolutions to the contract paths and omits the actor", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { actorId?: string };
      expect(request.actorId).toBeUndefined();
      const exception: Exception = {
        ...buildDemoPack().exceptions[0]!,
        id: "ex_1",
        jobId: "job_1",
        status: "accepted",
        resolution: {
          action: "accept",
          by: "sindhu",
          at: "2026-09-30T12:00:00.000Z",
          note: null,
          before: "12500000000",
          after: "12500000000",
        },
        auditTrail: [],
      };
      exception.auditTrail = exception.resolution ? [exception.resolution] : [];
      return new Response(JSON.stringify(exception), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const http = createHttpIngestionClient("http://127.0.0.1:8787");
    const result = await http.resolve(
      "ex/1",
      {
        action: "accept",
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "idem-http-1",
      },
      "sindhu",
      roles,
      csrf,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/v1/ingestion/exceptions/ex%2F1/resolve",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toBe("idem-http-1");
    expect(headers.get("x-csrf-token")).toBe(csrf);
    vi.unstubAllGlobals();
  });

  it("fails closed without a csrf token and surfaces API and network rejections", async () => {
    const http = createHttpIngestionClient("http://127.0.0.1:8787");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const missing = await http.resolve(
      "ex_1",
      {
        action: "accept",
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: "idem-http-csrf",
      },
      "sindhu",
      roles,
      "  ",
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("AUTH_CSRF_FAILED");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "AUTH_SCOPE_DENIED", message: "Role cannot resolve." },
        }),
        { status: 403 },
      ),
    );
    const denied = await http.bulkAccept(
      {
        jobId: "job_1",
        exceptionIds: ["ex_1"],
        note: null,
        idempotencyKey: "idem-http-role",
      },
      "viewer",
      ["viewer"],
      csrf,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("AUTH_SCOPE_DENIED");

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "AUTH_CSRF_FAILED",
            message: "Missing or invalid x-csrf-token for a cookie-authenticated write",
          },
        }),
        { status: 403 },
      ),
    );
    const uploadDenied = await http.upload(
      { files: [csv], idempotencyKey: "idem-upload-http" },
      csrf,
    );
    expect(uploadDenied.ok).toBe(false);
    if (!uploadDenied.ok) expect(uploadDenied.error.code).toBe("AUTH_CSRF_FAILED");
    const uploadInit = fetchMock.mock.calls.at(-1)?.[1];
    expect(new Headers(uploadInit?.headers).get("idempotency-key")).toBe("idem-upload-http");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const offline = await http.upload(
      { files: [csv], idempotencyKey: "idem-upload-offline" },
      csrf,
    );
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.error.code).toBe("INGESTION_UNAVAILABLE");
    vi.unstubAllGlobals();
  });
});
