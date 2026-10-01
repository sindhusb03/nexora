import { beforeAll, describe, expect, it } from "vitest";

import { ingestionJobSchema } from "@nexora/contracts";

import { writeXlsx } from "../src/imports/xlsx-write.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const unbalanced = [
  "Broken balance sheet,USD",
  "Year ended 31 December 2024",
  "Account,2024,2023",
  "Cash,1000,900",
  "Accounts Payable,200,180",
  "Retained Earnings,300,250",
  "Sundry consulting fee,50,40",
].join("\n");

describe("ingestion HTTP", () => {
  let app: TestApp;
  let tenantId = "";
  let entityId = "";
  let otherTenantId = "";

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-1", "owner-2");
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Ingestion Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    expect(tenant.status).toBe(201);
    tenantId = (await readJson<{ tenantId: string }>(tenant)).tenantId;
    const entity = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Ingestion Co", functionalCurrency: "USD" },
    });
    expect(entity.status).toBe(201);
    entityId = (await readJson<{ entityId: string }>(entity)).entityId;
    const other = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Other Co", homeRegion: "us-east-1", ownerActorId: "owner-2" },
    });
    otherTenantId = (await readJson<{ tenantId: string }>(other)).tenantId;
  });

  it("uploads, lists values and exceptions, resolves, and bulk-accepts", async () => {
    const first = await upload("ingest-1", unbalanced, "balance-sheet.csv");
    expect(first.status).toBe(201);
    const job = ingestionJobSchema.parse(await first.json());
    expect(job.status).toBe("needs_review");
    expect(job.counts.exceptionsError).toBeGreaterThan(0);
    expect(job.documents[0]?.fileName).toBe("balance-sheet.csv");

    const replay = await upload("ingest-1", unbalanced, "balance-sheet.csv");
    expect(replay.status).toBe(201);
    expect(ingestionJobSchema.parse(await replay.json()).jobId).toBe(job.jobId);

    const mismatch = await upload("ingest-1", `${unbalanced}\n`, "balance-sheet.csv");
    expect(mismatch.status).toBe(409);

    const hidden = await call(app, "GET", `/ingestion/jobs/${job.jobId}`, {
      actor: "owner-2",
      tenant: otherTenantId,
      region: "us-east-1",
    });
    expect(hidden.status).toBe(404);

    const values = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(values.status).toBe(200);
    const valueBody = (await values.json()) as {
      values: { provenance: { fileName: string; rawText: string }; label: string }[];
    };
    expect(valueBody.values.some((value) => value.label === "Cash")).toBe(true);
    expect(valueBody.values[0]?.provenance.fileName).toBe("balance-sheet.csv");
    expect(valueBody.values[0]?.provenance.rawText.length).toBeGreaterThan(0);

    const filtered = await call(
      app,
      "GET",
      `/ingestion/jobs/${job.jobId}/exceptions?type=bs_balance&severity=error`,
      { actor: "owner-1", tenant: tenantId, region: "us-east-1" },
    );
    expect(filtered.status).toBe(200);
    const exceptions = (await filtered.json()) as {
      exceptions: {
        id: string;
        type: string;
        severity: string;
        values: { expected: string | null };
      }[];
    };
    expect(exceptions.exceptions.length).toBeGreaterThan(0);
    expect(exceptions.exceptions.every((exception) => exception.type === "bs_balance")).toBe(true);

    const mapping = await call(
      app,
      "GET",
      `/ingestion/jobs/${job.jobId}/exceptions?type=mapping_low_confidence`,
      { actor: "owner-1", tenant: tenantId, region: "us-east-1" },
    );
    const mappingBody = (await mapping.json()) as { exceptions: { id: string }[] };
    expect(mappingBody.exceptions.length).toBeGreaterThan(0);

    const resolved = await call(
      app,
      "POST",
      `/ingestion/exceptions/${exceptions.exceptions[0]?.id}/resolve`,
      {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
        body: { action: "accept", note: "Reviewed unbalanced presentation" },
      },
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = (await resolved.json()) as { status: string };
    expect(resolvedBody.status).toBe("accepted");

    const tooStrict = await call(app, "POST", "/ingestion/exceptions/bulk-accept", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { jobId: job.jobId, minConfidence: "0.90" },
    });
    expect(tooStrict.status).toBe(200);
    expect(((await tooStrict.json()) as { accepted: number }).accepted).toBe(0);

    const accepted = await call(app, "POST", "/ingestion/exceptions/bulk-accept", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { jobId: job.jobId, minConfidence: "0.50" },
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { accepted: number }).accepted).toBeGreaterThan(0);
  });

  async function readJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  async function upload(key: string, text: string, fileName: string): Promise<Response> {
    const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
    if (session instanceof Response) return session;
    const form = new FormData();
    form.set("entityId", entityId);
    form.set("file", new File([text], fileName, { type: "text/csv" }));
    return app.request("/ingestion/uploads", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": key,
      },
      body: form,
    });
  }
});

describe("ingestion posting idempotency", () => {
  let app: TestApp;
  let tenantId = "";
  let entityId = "";

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-1");
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Posted Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    tenantId = (await readJson<{ tenantId: string }>(tenant)).tenantId;
    const entity = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Posted Co", functionalCurrency: "USD" },
    });
    entityId = (await readJson<{ entityId: string }>(entity)).entityId;
  });

  it("posts a balanced package once and ignores a second upload of the same bytes", async () => {
    const bytes = postingWorkbook();
    const first = await uploadBytes(app, tenantId, entityId, "post-1", bytes);
    expect(first.status).toBe(201);
    const job = await readJson<{ jobId: string; status: string }>(first);
    expect(job.status).toBe("posted");
    const before = await journalCount(app, tenantId, entityId);
    expect(before).toBe(2);
    const second = await uploadBytes(app, tenantId, entityId, "post-2", bytes);
    expect(second.status).toBe(201);
    const again = await readJson<{ jobId: string; status: string }>(second);
    expect(again.jobId).toBe(job.jobId);
    expect(await journalCount(app, tenantId, entityId)).toBe(before);
  });
});

describe("comparative period posting", () => {
  it("reconciles a comparative year instead of posting it again", async () => {
    const app = await testApp();
    await sessions(app).register("platform-admin", "owner-1");
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Year Two", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    const tenantId = (await readJson<{ tenantId: string }>(tenant)).tenantId;
    const entity = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Year Two", functionalCurrency: "USD" },
    });
    const entityId = (await readJson<{ entityId: string }>(entity)).entityId;
    const first = await uploadBytes(app, tenantId, entityId, "year-1", postingWorkbook());
    expect((await readJson<{ status: string }>(first)).status).toBe("posted");
    const second = await uploadBytes(app, tenantId, entityId, "year-2", nextYearWorkbook());
    expect(second.status).toBe(201);
    const job = await readJson<{ status: string }>(second);
    expect(job.status).toBe("posted");
    expect(await journalCount(app, tenantId, entityId)).toBe(3);
    const periods = await readJson<{ periods: { periodId: string; endDate: string }[] }>(
      await call(app, "GET", `/v1/entities/${entityId}/periods`, {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
      }),
    );
    const next = periods.periods.find((period) => period.endDate.startsWith("2025-12-31"));
    expect(next).toBeTruthy();
    const statement = await readJson<{ cashFlow: { endingCash: { minor: string } } }>(
      await call(app, "GET", `/v1/entities/${entityId}/periods/${next?.periodId}/statements`, {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
      }),
    );
    expect(statement.cashFlow.endingCash.minor).toBe("170000");
  });
});

describe("production mapping proposer", () => {
  it("does not trust a confidence marker embedded in the upload", async () => {
    const app = await testApp({ production: true, passwordCost: 19456 });
    await sessions(app).register("platform-admin", "owner-1");
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Prod Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    const tenantId = (await readJson<{ tenantId: string }>(tenant)).tenantId;
    const entity = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Prod Co", functionalCurrency: "USD" },
    });
    const entityId = (await readJson<{ entityId: string }>(entity)).entityId;
    const csv = [
      "Balance Sheet,Year ended 31 December 2024",
      "Treasury sweep [ai:cash:0.99],10.00",
    ].join("\n");
    const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
    if (session instanceof Response) throw new Error("session");
    const form = new FormData();
    form.set("entityId", entityId);
    form.set("file", new File([csv], "balance-sheet.csv", { type: "text/csv" }));
    const uploaded = await app.request("/ingestion/uploads", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": "prod-marker",
      },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const job = await readJson<{ jobId: string }>(uploaded);
    const values = await readJson<{
      values: {
        mappingAccepted: boolean;
        mappingMethod: string | null;
        mappingConfidence: string | null;
        accountCode: string | null;
      }[];
    }>(
      await app.request(`/ingestion/jobs/${job.jobId}/values`, {
        headers: { cookie: session.cookie },
      }),
    );
    const line = values.values.find((value) => value.accountCode !== undefined);
    expect(line?.mappingAccepted).not.toBe(true);
    expect(line?.mappingConfidence).not.toBe("0.99");
    expect(line?.accountCode).toBeNull();
    const exceptions = await readJson<{ exceptions: { type: string }[] }>(
      await app.request(`/ingestion/jobs/${job.jobId}/exceptions`, {
        headers: { cookie: session.cookie },
      }),
    );
    expect(
      exceptions.exceptions.some((exception) => exception.type === "mapping_low_confidence"),
    ).toBe(true);
  });
});

describe("fiscal year resolution", () => {
  it("posts a 30 June package into June periods", async () => {
    const app = await testApp();
    const { tenantId, entityId } = await tenantEntity(app, "June Books", {});
    const uploaded = await uploadBytes(
      app,
      tenantId,
      entityId,
      "june-post",
      packageWorkbook("30 June"),
    );
    expect(uploaded.status).toBe(201);
    expect((await readJson<{ status: string }>(uploaded)).status).toBe("posted");
    const periods = await periodEnds(app, tenantId, entityId);
    expect(periods.some((end) => end.startsWith("2024-06-30"))).toBe(true);
    expect(periods.some((end) => end.startsWith("2024-12-31"))).toBe(false);
  });

  it("blocks a bare year until the period end is confirmed", async () => {
    const app = await testApp();
    const { tenantId, entityId } = await tenantEntity(app, "Bare Year", {});
    const uploaded = await uploadText(
      app,
      tenantId,
      entityId,
      "bare-year",
      "balance-sheet.csv",
      "Balance Sheet\nAccount,2025\nCash,10.00\n",
    );
    expect(uploaded.status).toBe(201);
    const job = await readJson<{ jobId: string; status: string }>(uploaded);
    expect(job.status).toBe("needs_review");
    expect(await journalCount(app, tenantId, entityId)).toBe(0);
    const exceptions = await readJson<{ exceptions: { type: string }[] }>(
      await call(app, "GET", `/ingestion/jobs/${job.jobId}/exceptions`, {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
      }),
    );
    expect(exceptions.exceptions.some((exception) => exception.type === "confirm_period_end")).toBe(
      true,
    );
  });

  it("uses the organisation fiscal year end for a year-only header", async () => {
    const app = await testApp();
    const { tenantId, entityId } = await tenantEntity(app, "Org June", {
      fiscalYearEndMonth: 6,
      fiscalYearEndDay: 30,
    });
    const uploaded = await uploadBytes(app, tenantId, entityId, "org-june", bareYearWorkbook());
    expect(uploaded.status).toBe(201);
    const job = await readJson<{ jobId: string; status: string }>(uploaded);
    expect(job.status).toBe("posted");
    const periods = await periodEnds(app, tenantId, entityId);
    expect(periods.some((end) => end.startsWith("2024-06-30"))).toBe(true);
    expect(periods.some((end) => end.includes("-12-31"))).toBe(false);
  });

  it("blocks a period end that disagrees with the ledger or the organisation", async () => {
    const app = await testApp();
    const { tenantId, entityId } = await tenantEntity(app, "December Books", {});
    const first = await uploadBytes(
      app,
      tenantId,
      entityId,
      "dec-post",
      packageWorkbook("31 December"),
    );
    expect((await readJson<{ status: string }>(first)).status).toBe("posted");
    const before = await journalCount(app, tenantId, entityId);
    const clash = await uploadBytes(
      app,
      tenantId,
      entityId,
      "june-clash",
      packageWorkbook("30 June"),
    );
    const clashJob = await readJson<{ jobId: string; status: string }>(clash);
    expect(clashJob.status).toBe("needs_review");
    expect(await journalCount(app, tenantId, entityId)).toBe(before);
    const clashExceptions = await readJson<{ exceptions: { message: string }[] }>(
      await call(app, "GET", `/ingestion/jobs/${clashJob.jobId}/exceptions`, {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
      }),
    );
    expect(
      clashExceptions.exceptions.some((exception) =>
        exception.message.toLowerCase().includes("existing period"),
      ),
    ).toBe(true);

    const juneOrg = await tenantEntity(app, "June Org", {
      fiscalYearEndMonth: 6,
      fiscalYearEndDay: 30,
    });
    const december = await uploadBytes(
      app,
      juneOrg.tenantId,
      juneOrg.entityId,
      "org-clash",
      packageWorkbook("31 December"),
    );
    const decemberJob = await readJson<{ jobId: string; status: string }>(december);
    expect(decemberJob.status).toBe("needs_review");
    expect(await journalCount(app, juneOrg.tenantId, juneOrg.entityId)).toBe(0);
    const orgExceptions = await readJson<{ exceptions: { message: string }[] }>(
      await call(app, "GET", `/ingestion/jobs/${decemberJob.jobId}/exceptions`, {
        actor: "owner-1",
        tenant: juneOrg.tenantId,
        region: "us-east-1",
      }),
    );
    expect(
      orgExceptions.exceptions.some((exception) =>
        exception.message.toLowerCase().includes("organisation fiscal year"),
      ),
    ).toBe(true);
  });
});

async function tenantEntity(
  app: TestApp,
  name: string,
  fiscal: { fiscalYearEndMonth?: number; fiscalYearEndDay?: number },
): Promise<{ tenantId: string; entityId: string }> {
  await sessions(app).register("platform-admin", "owner-1");
  const tenant = await call(app, "POST", "/v1/tenants", {
    actor: "platform-admin",
    region: "us-east-1",
    body: { name, homeRegion: "us-east-1", ownerActorId: "owner-1" },
  });
  const tenantId = (await readJson<{ tenantId: string }>(tenant)).tenantId;
  const entity = await call(app, "POST", "/v1/entities", {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
    body: { legalName: name, functionalCurrency: "USD", ...fiscal },
  });
  const entityId = (await readJson<{ entityId: string }>(entity)).entityId;
  return { tenantId, entityId };
}

async function uploadText(
  app: TestApp,
  tenantId: string,
  entityId: string,
  key: string,
  fileName: string,
  text: string,
): Promise<Response> {
  const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
  if (session instanceof Response) return session;
  const form = new FormData();
  form.set("entityId", entityId);
  form.set("file", new File([text], fileName, { type: "text/csv" }));
  return app.request("/ingestion/uploads", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "idempotency-key": key,
    },
    body: form,
  });
}

async function periodEnds(app: TestApp, tenantId: string, entityId: string): Promise<string[]> {
  const listed = await readJson<{ periods: { endDate: string }[] }>(
    await call(app, "GET", `/v1/entities/${entityId}/periods`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
    }),
  );
  return listed.periods.map((period) => period.endDate);
}

function packageWorkbook(monthDay: string): Uint8Array {
  const prior = `Year ended ${monthDay} 2023`;
  const current = `Year ended ${monthDay} 2024`;
  return writeXlsx([
    {
      name: "Balance Sheet",
      cells: [
        { row: 1, col: 1, value: "Balance Sheet", kind: "string" },
        { row: 1, col: 2, value: prior, kind: "string" },
        { row: 1, col: 3, value: current, kind: "string" },
        { row: 2, col: 1, value: "Cash", kind: "string" },
        { row: 2, col: 2, value: "1000.00", kind: "number" },
        { row: 2, col: 3, value: "1500.00", kind: "number" },
        { row: 3, col: 1, value: "Accounts Payable", kind: "string" },
        { row: 3, col: 2, value: "200.00", kind: "number" },
        { row: 3, col: 3, value: "200.00", kind: "number" },
        { row: 4, col: 1, value: "Retained Earnings", kind: "string" },
        { row: 4, col: 2, value: "800.00", kind: "number" },
        { row: 4, col: 3, value: "1300.00", kind: "number" },
      ],
    },
    {
      name: "Income Statement",
      cells: [
        { row: 1, col: 1, value: "Income Statement", kind: "string" },
        { row: 1, col: 2, value: current, kind: "string" },
        { row: 2, col: 1, value: "Revenue", kind: "string" },
        { row: 2, col: 2, value: "700.00", kind: "number" },
        { row: 3, col: 1, value: "Operating Expenses", kind: "string" },
        { row: 3, col: 2, value: "200.00", kind: "number" },
      ],
    },
  ]);
}

function bareYearWorkbook(): Uint8Array {
  return writeXlsx([
    {
      name: "Balance Sheet",
      cells: [
        { row: 1, col: 1, value: "Balance Sheet", kind: "string" },
        { row: 1, col: 2, value: "2023", kind: "string" },
        { row: 1, col: 3, value: "2024", kind: "string" },
        { row: 2, col: 1, value: "Cash", kind: "string" },
        { row: 2, col: 2, value: "1000.00", kind: "number" },
        { row: 2, col: 3, value: "1500.00", kind: "number" },
        { row: 3, col: 1, value: "Accounts Payable", kind: "string" },
        { row: 3, col: 2, value: "200.00", kind: "number" },
        { row: 3, col: 3, value: "200.00", kind: "number" },
        { row: 4, col: 1, value: "Retained Earnings", kind: "string" },
        { row: 4, col: 2, value: "800.00", kind: "number" },
        { row: 4, col: 3, value: "1300.00", kind: "number" },
      ],
    },
    {
      name: "Income Statement",
      cells: [
        { row: 1, col: 1, value: "Income Statement", kind: "string" },
        { row: 1, col: 2, value: "2024", kind: "string" },
        { row: 2, col: 1, value: "Revenue", kind: "string" },
        { row: 2, col: 2, value: "700.00", kind: "number" },
        { row: 3, col: 1, value: "Operating Expenses", kind: "string" },
        { row: 3, col: 2, value: "200.00", kind: "number" },
      ],
    },
  ]);
}

function nextYearWorkbook(): Uint8Array {
  return writeXlsx([
    {
      name: "Balance Sheet",
      cells: [
        { row: 1, col: 1, value: "Balance Sheet", kind: "string" },
        { row: 1, col: 2, value: "Year ended 31 December 2024", kind: "string" },
        { row: 1, col: 3, value: "Year ended 31 December 2025", kind: "string" },
        { row: 2, col: 1, value: "Cash", kind: "string" },
        { row: 2, col: 2, value: "1500.00", kind: "number" },
        { row: 2, col: 3, value: "1700.00", kind: "number" },
        { row: 3, col: 1, value: "Accounts Payable", kind: "string" },
        { row: 3, col: 2, value: "200.00", kind: "number" },
        { row: 3, col: 3, value: "200.00", kind: "number" },
        { row: 4, col: 1, value: "Retained Earnings", kind: "string" },
        { row: 4, col: 2, value: "1300.00", kind: "number" },
        { row: 4, col: 3, value: "1500.00", kind: "number" },
      ],
    },
    {
      name: "Income Statement",
      cells: [
        { row: 1, col: 1, value: "Income Statement", kind: "string" },
        { row: 1, col: 2, value: "Year ended 31 December 2025", kind: "string" },
        { row: 2, col: 1, value: "Revenue", kind: "string" },
        { row: 2, col: 2, value: "400.00", kind: "number" },
        { row: 3, col: 1, value: "Operating Expenses", kind: "string" },
        { row: 3, col: 2, value: "200.00", kind: "number" },
      ],
    },
  ]);
}

function postingWorkbook(): Uint8Array {
  return packageWorkbook("31 December");
}

describe("new adversarial complete packages never auto-post ambiguity", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
  });
  const cases = [
    "YTD",
    "Q3",
    "Half-year",
    "Nine-months ended",
    "Six months ended",
    "Three months ended",
    "conflict",
    "FY",
    "qualifier-current",
    "qualifier-units",
    "qualifier-brackets",
    "qualifier-net",
    "bank-mismatch",
  ];
  it.each(cases)("blocks %s with no journals or periods", async (variant) => {
    const { tenantId, entityId } = await tenantEntity(app, variant, {});
    const header = variant === "FY" ? "FY25" : "Year ended 31 December 2025";
    const qualifier = variant.startsWith("qualifier")
      ? ({
          "qualifier-current": " current",
          "qualifier-units": " (units)",
          "qualifier-brackets": " [deferred]",
          "qualifier-net": " (net of returns)",
        }[variant] ?? "")
      : "";
    const preamble =
      variant === "conflict"
        ? "As at 30 June 2025"
        : cases.slice(0, 6).includes(variant)
          ? variant
          : "Financial statements USD";
    const bs = [
      [preamble],
      ["Account", "Year ended 31 December 2024", header],
      ["Cash", "2600", "2940"],
      ["Accounts payable", "600", "600"],
      ["Retained earnings", "2000", "2340"],
    ];
    const income = [
      [preamble],
      ["Account", header],
      [`Revenue${qualifier}`, "780"],
      ["Operating expenses", "440"],
    ];
    const sheets = [
      { name: "Balance Sheet", rows: bs },
      { name: "Income Statement", rows: income },
    ];
    if (variant === "bank-mismatch")
      sheets.push({
        name: "Bank",
        rows: [
          ["USD"],
          ["Date", "Description", "Amount", "Balance"],
          ["2025-01-01", "Opening balance", "", "2600"],
          ["2025-12-31", "Receipt", "340", "2940"],
          ["2025-12-31", "Closing balance", "", "2941"],
        ],
      });
    const bytes = writeXlsx(
      sheets.map(({ name, rows }) => ({
        name,
        cells: rows.flatMap((r, i) =>
          r.map((value, j) => ({ row: i + 1, col: j + 1, value, kind: "string" as const })),
        ),
      })),
    );
    const response = await uploadBytes(app, tenantId, entityId, variant, bytes);
    expect(response.status).toBe(201);
    const job = (await response.json()) as { status: string; counts: { exceptionsError: number } };
    expect(job.status).toBe("needs_review");
    expect(job.counts.exceptionsError).toBeGreaterThan(0);
    expect(await journalCount(app, tenantId, entityId)).toBe(0);
    expect(await periodEnds(app, tenantId, entityId)).toEqual([]);
  });
  it("posts the new control's exact annual periods despite report metadata", async () => {
    const { tenantId, entityId } = await tenantEntity(app, "Date metadata control", {});
    const rows = [
      ["Report generated: as of 16 February 2026"],
      ["Year ended 30 September 2025"],
      ["Account", "2024", "2025"],
      ["Cash", "2600", "2940"],
      ["Accounts payable", "600", "600"],
      ["Retained earnings", "2000", "2340"],
    ];
    const income = [
      ["Run at: as of 16 February 2026"],
      ["Year ended 30 September 2025"],
      ["Account", "2025"],
      ["Revenue", "780"],
      ["Operating expenses", "440"],
    ];
    const bytes = writeXlsx(
      [
        { name: "Balance Sheet", rows },
        { name: "Income Statement", rows: income },
      ].map(({ name, rows: grid }) => ({
        name,
        cells: grid.flatMap((r, i) =>
          r.map((value, j) => ({ row: i + 1, col: j + 1, value, kind: "string" as const })),
        ),
      })),
    );
    const response = await uploadBytes(app, tenantId, entityId, "new-control", bytes);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { status: string }).status).toBe("posted");
    expect((await periodEnds(app, tenantId, entityId)).sort()).toEqual([
      "2024-09-30",
      "2025-09-30",
    ]);
    expect(await journalCount(app, tenantId, entityId)).toBe(2);
  });
});

async function uploadBytes(
  app: TestApp,
  tenantId: string,
  entityId: string,
  key: string,
  bytes: Uint8Array,
): Promise<Response> {
  const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
  if (session instanceof Response) return session;
  const form = new FormData();
  form.set("entityId", entityId);
  form.set("file", new File([Buffer.from(bytes)], "posted-statements.xlsx"));
  return app.request("/ingestion/uploads", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "idempotency-key": key,
    },
    body: form,
  });
}

async function journalCount(app: TestApp, tenantId: string, entityId: string): Promise<number> {
  const listed = await call(app, "GET", `/v1/entities/${entityId}/journals`, {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
  });
  const body = await readJson<{ journals: unknown[] }>(listed);
  return body.journals.length;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
