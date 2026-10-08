import "@testing-library/jest-dom/vitest";
import { HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE, type Exception } from "@nexora/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getIngestionClient, isMockIngestion } from "../app/review/client";
import { DetailView } from "../app/review/detail-view";
import { createHttpIngestionClient } from "../app/review/http-client";
import { createMockIngestionClient, memoryStore } from "../app/review/mock-client";
import { QueueView } from "../app/review/queue-view";

const navigation = vi.hoisted(() => ({ push: vi.fn(), search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => navigation.search,
}));
vi.mock("../app/review/client", () => ({
  getIngestionClient: vi.fn(),
  isMockIngestion: vi.fn(),
}));
vi.mock("../app/review/shell", () => {
  const setAsOf = vi.fn();
  return {
    useReviewSession: () => ({ actorId: "sindhu", roles: ["controller"], csrfToken: "csrf-test" }),
    useReviewAsOf: () => ({ setAsOf }),
  };
});

async function readyClient() {
  let now = Date.parse("2026-09-30T12:00:00.000Z");
  const store = memoryStore();
  const client = createMockIngestionClient({ now: () => now, store });
  const uploaded = await client.upload(
    {
      files: [
        { fileName: "header.csv", mediaType: "text/csv", byteLength: 1, contentBase64: "QQ==" },
      ],
      idempotencyKey: "header-probe-upload",
    },
    "csrf-test",
  );
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  now += 2_000;
  const listed = await client.getExceptions(uploaded.value.id);
  if (!listed.ok) throw new Error(listed.error.message);
  expect(new Set(listed.value.map((item) => item.id)).size).toBe(listed.value.length);
  const empty = listed.value.find(
    (item) => item.type === "header_as_value" && item.values.actual === null,
  )!;
  // Also test a high score on the excluded type and the advisory threshold boundary.
  store.write(
    store.read().map((job) => ({
      ...job,
      exceptions: job.exceptions.map((item) =>
        item.type === "low_confidence_extraction"
          ? { ...item, confidence: "0.9900" }
          : item.type === "missing_period"
            ? { ...item, confidence: "0.8999" }
            : item,
      ),
    })),
  );
  vi.mocked(getIngestionClient).mockReturnValue(client);
  return {
    client,
    store,
    jobId: uploaded.value.id,
    empty,
    numbered: listed.value.find(
      (item) => item.type === "header_as_value" && item.values.actual !== null,
    )!,
  };
}

beforeEach(() => {
  vi.mocked(isMockIngestion).mockReturnValue(true);
  navigation.search = new URLSearchParams();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("header review probe", () => {
  it("disables numbered header Accept in detail, including a requested accept action and the a key", async () => {
    const { client, jobId, numbered } = await readyClient();
    expect(numbered).toBeDefined();
    const resolve = vi.spyOn(client, "resolve");
    navigation.search = new URLSearchParams("action=accept");
    render(<DetailView jobId={jobId} exceptionId={numbered.id} />);
    const accept = await screen.findByRole("button", { name: "Accept", exact: true });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAccessibleDescription(HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE);
    expect(screen.getByRole("button", { name: "Correct value" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Not applicable" })).toBeEnabled();
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.queryByTestId("confirm-resolution")).not.toBeInTheDocument();
    expect(screen.getByText("Open", { exact: true })).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("allows an empty header to be accepted in detail", async () => {
    const { jobId, empty } = await readyClient();
    render(<DetailView jobId={jobId} exceptionId={empty.id} />);
    const accept = await screen.findByRole("button", { name: "Accept", exact: true });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    fireEvent.click(screen.getByTestId("confirm-resolution"));
    expect(await screen.findByText("Accepted", { exact: true })).toBeInTheDocument();
  });

  it("blocks queue a without a request and excludes numbered headers and low confidence from the bulk dialog", async () => {
    const { client, jobId, numbered, empty } = await readyClient();
    expect(numbered).toBeDefined();
    const resolve = vi.spyOn(client, "resolve");
    render(<QueueView jobId={jobId} />);
    const link = await screen.findByRole("link", { name: numbered.message });
    const row = link.closest("tr")!;
    fireEvent.click(row);
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByTestId("queue-notice")).toHaveTextContent(
      HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
    );
    expect(screen.queryByTestId("confirm-key")).not.toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
    expect(within(row).getByText("Open")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "c" });
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining("?action=correct"));
    fireEvent.click(screen.getByTestId("bulk-accept"));
    const list = await screen.findByTestId("bulk-list");
    expect(list).toHaveTextContent(empty.message);
    expect(list).not.toHaveTextContent(numbered.message);
    expect(list).not.toHaveTextContent("low_confidence_extraction");
    expect(list).not.toHaveTextContent("missing_period");
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "n" });
    await waitFor(() => expect(within(row).getByText("Not applicable")).toBeInTheDocument());
  });

  it.each(["detail", "queue"])(
    "shows the HTTP 422 message in %s and keeps the item open without audit changes",
    async (view) => {
      const { client, store, jobId, empty } = await readyClient();
      // Simulate a stale view: the server now has a value on the formerly empty header.
      const http = createHttpIngestionClient("https://ingestion.test");
      const responses: Response[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          expect(url).toBe(`https://ingestion.test/ingestion/exceptions/${empty.id}/resolve`);
          expect(init.method).toBe("POST");
          const request = JSON.parse(String(init.body));
          expect(request).toEqual({ action: "accept", note: "Reviewed: accept" });
          const result = await client.resolve(
            empty.id,
            { ...request, correctedMinor: null, accountCode: null, idempotencyKey: "http-422" },
            "sindhu",
            ["controller"],
            "csrf-test",
          );
          if (result.ok) throw new Error("Expected header rejection");
          const response = new Response(
            JSON.stringify({ error: { code: result.error.code, message: result.error.message } }),
            { status: 422 },
          );
          responses.push(response);
          return response;
        }),
      );
      vi.mocked(getIngestionClient).mockReturnValue({ ...client, resolve: http.resolve });
      render(
        view === "detail" ? (
          <DetailView jobId={jobId} exceptionId={empty.id} />
        ) : (
          <QueueView jobId={jobId} />
        ),
      );
      await screen.findByText(empty.message, { exact: true });
      store.write(
        store.read().map((job) => ({
          ...job,
          exceptions: job.exceptions.map((item) =>
            item.id === empty.id ? { ...item, values: { ...item.values, actual: "100" } } : item,
          ),
        })),
      );
      if (view === "detail") {
        fireEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
        fireEvent.click(screen.getByTestId("confirm-resolution"));
      } else {
        fireEvent.click(screen.getByRole("link", { name: empty.message }).closest("tr")!);
        fireEvent.keyDown(window, { key: "a" });
        fireEvent.keyDown(window, { key: "a" });
      }
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `HEADER_VALUE_NOT_ACCEPTABLE: ${HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE}`,
      );
      expect(responses[0]?.status).toBe(422);
      const scope =
        view === "detail"
          ? screen.getByTestId("screen-detail")
          : screen.getByRole("link", { name: empty.message }).closest("tr")!;
      expect(within(scope).getByText("Open", { exact: true })).toBeInTheDocument();
      const after = await client.getExceptions(jobId);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.find((item: Exception) => item.id === empty.id)).toMatchObject({
        status: "open",
        resolution: null,
        auditTrail: [],
      });
    },
  );
});

function httpReviewClient() {
  const jobId = "10000000-0000-4000-8000-000000000001";
  const documentId = "10000000-0000-4000-8000-000000000002";
  const valueId = "10000000-0000-4000-8000-000000000003";
  const provenance = {
    fileName: "statement.csv",
    page: null,
    sheet: null,
    row: 4,
    col: 2,
    bbox: null,
    rawText: "Cash,100",
  };
  const job = {
    jobId,
    entityId: "10000000-0000-4000-8000-000000000004",
    status: "needs_review",
    currency: "USD",
    formulaVersion: null,
    inputHash: null,
    outputHash: null,
    documents: [
      {
        documentId,
        fileName: "statement.csv",
        statementKinds: ["balance_sheet"],
        status: "parsed",
        error: null,
      },
    ],
    counts: {
      documents: 1,
      values: 3,
      exceptionsOpen: 6,
      exceptionsError: 1,
      exceptionsWarn: 4,
      exceptionsInfo: 1,
    },
    createdAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-30T12:00:00.000Z",
  };
  const value = {
    valueId,
    documentId,
    statementType: "balance_sheet",
    role: "line",
    label: "Cash",
    periodKey: "FY2025",
    periodEnd: "2025-12-31",
    currency: "USD",
    scale: "units",
    minor: "10000",
    accountCode: "cash",
    mappingConfidence: "0.90",
    mappingMethod: "stub",
    mappingAccepted: false,
    provenance,
  };
  const items = [
    {
      type: "mapping_low_confidence",
      severity: "warn",
      status: "open",
      message: "Eligible boundary mapping",
    },
    {
      type: "mapping_low_confidence",
      severity: "error",
      status: "open",
      message: "Eligible error mapping",
    },
    { type: "missing_period", severity: "info", status: "open", message: "Unrelated advisory" },
    {
      type: "low_confidence_extraction",
      severity: "warn",
      status: "open",
      message: "Unrelated extraction",
    },
    {
      type: "mapping_low_confidence",
      severity: "warn",
      status: "accepted",
      message: "Already accepted mapping",
    },
    {
      type: "mapping_low_confidence",
      severity: "warn",
      status: "open",
      message: "Below threshold mapping",
      low: true,
    },
    {
      type: "mapping_low_confidence",
      severity: "warn",
      status: "open",
      message: "Missing value mapping",
      missing: true,
    },
  ].map((item, index) => ({
    ...item,
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    jobId,
    documentId,
    values: { expected: null, actual: "10000", diff: null },
    provenance: {
      valueIds: [
        item.low
          ? "10000000-0000-4000-8000-000000000005"
          : item.missing
            ? "10000000-0000-4000-8000-000000000006"
            : valueId,
        // The server uses the first ID even when another linked value is eligible.
        valueId,
      ],
      locations: [provenance],
    },
    resolution: null,
  }));
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/resolve"))
      return Response.json(
        { error: { code: "TEST_REJECTION", message: "Leave open" } },
        { status: 422 },
      );
    if (url.endsWith("/values"))
      return Response.json({
        values: [
          value,
          { ...value, valueId: "10000000-0000-4000-8000-000000000007", accountCode: "INVALID" },
          {
            ...value,
            valueId: "10000000-0000-4000-8000-000000000005",
            mappingConfidence: "0.8999",
          },
        ],
      });
    if (url.endsWith("/exceptions")) return Response.json({ exceptions: items });
    return Response.json(job);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(isMockIngestion).mockReturnValue(false);
  vi.mocked(getIngestionClient).mockReturnValue(
    createHttpIngestionClient("https://ingestion.test"),
  );
  return { jobId, exceptionId: items[0]!.id, fetchMock };
}

describe("HTTP review controls", () => {
  it("lists only open mapping exceptions at or above the bulk threshold, including errors", async () => {
    const { jobId } = httpReviewClient();
    render(<QueueView jobId={jobId} />);
    await screen.findByRole("link", { name: "Eligible boundary mapping" });
    expect(screen.getByTestId("bulk-accept")).toHaveTextContent("Bulk-accept 2 high-confidence");
    fireEvent.click(screen.getByTestId("bulk-accept"));
    const list = await screen.findByTestId("bulk-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Eligible boundary mapping");
    expect(list).toHaveTextContent("Eligible error mapping");
  });

  it("offers known lowercase accounts and sends the chosen code when remapping", async () => {
    const { jobId, exceptionId, fetchMock } = httpReviewClient();
    render(<DetailView jobId={jobId} exceptionId={exceptionId} />);
    fireEvent.click(await screen.findByTestId("action-remap"));
    const picker = screen.getByTestId("account-picker");
    expect(within(picker).getByRole("option", { name: "cash cash" })).toHaveValue("cash");
    expect(
      within(picker).queryByRole("option", { name: "INVALID INVALID" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("confirm-resolution")).toBeDisabled();
    fireEvent.change(picker, { target: { value: "cash" } });
    fireEvent.change(screen.getByTestId("resolution-note"), { target: { value: "Use cash" } });
    fireEvent.click(screen.getByTestId("confirm-resolution"));
    await screen.findByRole("alert");
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/resolve"));
    expect(call?.[0]).toBe(`https://ingestion.test/ingestion/exceptions/${exceptionId}/resolve`);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      action: "remap",
      note: "Use cash",
      accountCode: "cash",
    });
  });
});
