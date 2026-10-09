import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPgliteStore } from "@nexora/db";

import { journalKindFromSource, openingSourceRef } from "../src/classify-activity.js";
import * as documentParser from "../src/imports/document-parser.js";
import type { ParsedDocument } from "../src/imports/document-parser.js";
import { writeXlsx } from "../src/imports/xlsx-write.js";
import { computeStatementsForPeriod } from "../src/service.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

describe("ingestion opening journals", () => {
  let parsedDocument = confirmedDocument();
  let app: TestApp;
  let store: Awaited<ReturnType<typeof createPgliteStore>>;

  beforeAll(async () => {
    // This suite starts with confirmed dates and source values. Parser ambiguity
    // remains covered by ingestion.http.test.ts and is outside the posting path.
    const selectParser = documentParser.selectDocumentParser;
    vi.spyOn(documentParser, "selectDocumentParser").mockImplementation((fileName, bytes) =>
      fileName === "balances.xlsx"
        ? {
            id: "confirmed-opening-fixture",
            supports: () => true,
            parse: async () => parsedDocument,
          }
        : selectParser(fileName, bytes),
    );
    store = await createPgliteStore();
    app = await testApp({ store });
    await sessions(app).register("platform-admin", "owner-1");
  });

  afterAll(() => vi.restoreAllMocks());

  async function company(name: string, withYearEnd = true) {
    const tenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name, homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    const { tenantId } = (await tenant.json()) as { tenantId: string };
    const response = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        legalName: name,
        functionalCurrency: "USD",
        ...(withYearEnd ? { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 } : {}),
      },
    });
    const { entityId } = (await response.json()) as { entityId: string };
    return { tenantId, entityId };
  }

  async function upload(
    tenantId: string,
    entityId: string,
    key: string,
    bytes = workbook(),
    document = confirmedDocument(),
  ) {
    parsedDocument = document;
    const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
    if (session instanceof Response) throw new Error("Session failed");
    const form = new FormData();
    form.set("entityId", entityId);
    form.set("file", new File([Buffer.from(bytes)], "balances.xlsx"));
    const response = await app.request("/ingestion/uploads", {
      method: "POST",
      body: form,
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": key,
      },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { jobId: string; status: string };
  }

  async function closingStatement(tenantId: string, entityId: string) {
    const periods = await store.listPeriods(tenantId, entityId);
    const closing = periods.find((period) => period.endDate.startsWith("2025-12-31"));
    expect(closing).toBeDefined();
    const { statement } = await computeStatementsForPeriod(
      store,
      tenantId,
      entityId,
      closing!.periodId,
    );
    return statement;
  }

  it("posts a balanced opening with mid-year income only before Nexora", async () => {
    const { tenantId, entityId } = await company("Mid-year opening");
    const job = await upload(tenantId, entityId, "mid-year");
    expect(
      job.status,
      JSON.stringify(await store.listIngestionExceptions(tenantId, job.jobId)),
    ).toBe("posted");
    const journals = await store.listJournals(tenantId, entityId, null);
    expect(journals).toHaveLength(2);
    const opening = journals.filter(
      (journal) => journalKindFromSource(journal.sourceRef) === "opening",
    );
    expect(opening).toHaveLength(1);
    expect(opening[0]?.sourceRef).toBe(openingSourceRef(`ingestion:${job.jobId}`));
    const period = (await store.listPeriods(tenantId, entityId)).find(
      (period) => period.periodId === opening[0]?.periodId,
    );
    expect(period?.startDate.slice(0, 10)).toBe("2025-06-30");
    expect(period?.endDate.slice(0, 10)).toBe("2025-06-30");
    const closingPeriod = (await store.listPeriods(tenantId, entityId)).find((period) =>
      period.endDate.startsWith("2025-12-31"),
    );
    expect(closingPeriod?.startDate.slice(0, 10)).toBe("2025-07-01");
    expect(journals.find((journal) => journal !== opening[0])?.sourceRef).toBe(
      `ingestion:${job.jobId}`,
    );
    const statement = await closingStatement(tenantId, entityId);
    expect(statement.beforeNexora).toMatchObject({
      revenueMinor: "50000",
      expensesMinor: "26000",
      netIncomeMinor: "24000",
    });
    expect(statement.incomeStatement).toMatchObject({
      revenueMinor: "70000",
      expensesMinor: "20000",
      netIncomeMinor: "50000",
    });
    expect(statement.cashFlow.endingCashMinor).toBe("150000");
    expect(statement.retainedEarnings).toMatchObject({
      openingMinor: "56000",
      beforeNexoraMinor: "24000",
      netIncomeMinor: "50000",
      endingMinor: "130000",
    });
    const openingStatement = await computeStatementsForPeriod(
      store,
      tenantId,
      entityId,
      opening[0]!.periodId,
    );
    expect(openingStatement.statement.incomeStatement.netIncomeMinor).toBe("0");
    const options = { actor: "owner-1", tenant: tenantId, region: "us-east-1" };
    const listed = await call(app, "GET", `/v1/entities/${entityId}/periods`, options);
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { periods: { periodId: string; opening: boolean }[] }).periods,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ periodId: opening[0]!.periodId, opening: true }),
      ]),
    );
    const workspace = await call(app, "GET", `/v1/workspace?entityId=${entityId}`, options);
    expect(workspace.status).toBe(200);
    const view = (await workspace.json()) as {
      statements: {
        periods: { periodId: string }[];
        rows: { values: { periodId: string }[] }[];
      };
    };
    expect(view.statements.periods.map((item: { periodId: string }) => item.periodId)).toEqual([
      closingPeriod!.periodId,
    ]);
    expect(
      view.statements.rows.every((row: { values: { periodId: string }[] }) =>
        row.values.every((value) => value.periodId === closingPeriod!.periodId),
      ),
    ).toBe(true);
  });

  it("posts only balance-sheet lines at year-end and no before Nexora income in 2025", async () => {
    const { tenantId, entityId } = await company("Year-end opening");
    const source = confirmedDocument();
    const document = {
      ...source,
      cells: source.cells.map((cell) => ({
        ...cell,
        ...(cell.periodEnd === "2025-06-30"
          ? { periodEnd: "2024-12-31", periodStart: "2024-01-01", periodKey: "2024-12-31" }
          : { periodStart: "2025-01-01" }),
        spanMonths: 12,
      })),
    };
    const job = await upload(tenantId, entityId, "year-end", workbook(), document);
    expect(
      job.status,
      JSON.stringify(await store.listIngestionExceptions(tenantId, job.jobId)),
    ).toBe("posted");
    const opening = (await store.listJournals(tenantId, entityId, null)).find(
      (journal) => journalKindFromSource(journal.sourceRef) === "opening",
    )!;
    const accounts = await store.listAccounts(tenantId, entityId);
    const codes = new Map(accounts.map((account) => [account.accountId, account.code]));
    expect(opening.lines.map((line) => codes.get(line.accountId)).sort()).toEqual([
      "accounts_payable",
      "cash",
      "retained_earnings",
    ]);
    expect(
      opening.lines.find((line) => codes.get(line.accountId) === "retained_earnings")?.creditMinor,
    ).toBe("80000");
    const statement = await closingStatement(tenantId, entityId);
    expect(statement.beforeNexora).toBeNull();
    expect(statement.retainedEarnings.openingMinor).toBe("80000");
    expect(statement.retainedEarnings.endingMinor).toBe("130000");
  });

  it("blocks opening income when the company has no year-end", async () => {
    const { tenantId, entityId } = await company("Missing year-end", false);
    const job = await upload(tenantId, entityId, "missing-year-end");
    expect(job.status).toBe("needs_review");
    expect(await store.listJournals(tenantId, entityId, null)).toHaveLength(0);
    expect(await store.listIngestionExceptions(tenantId, job.jobId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "Your company has no year-end set, so these opening figures can't be placed. Set your year-end in company settings, then confirm this upload again.",
        }),
      ]),
    );
  });

  it("blocks later income that starts on or before the opening date", async () => {
    const { tenantId, entityId } = await company("Overlapping income");
    const source = confirmedDocument();
    const document = {
      ...source,
      cells: source.cells.map((cell) =>
        cell.statementType === "income_statement" && cell.periodEnd === "2025-12-31"
          ? { ...cell, periodStart: "2025-01-01" }
          : cell,
      ),
    };
    const job = await upload(tenantId, entityId, "overlapping", workbook(), document);
    expect(job.status).toBe("needs_review");
    expect(await store.listJournals(tenantId, entityId, null)).toHaveLength(0);
    expect(await store.listIngestionExceptions(tenantId, job.jobId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "This income statement starts on 1 Jan, before your opening balances on 30 Jun. Upload figures from 1 Jul onwards, or replace your opening balances.",
        }),
      ]),
    );
  });

  it("re-confirming the same snapshot leaves one opening and identical figures", async () => {
    const { tenantId, entityId } = await company("Opening replay");
    const bytes = workbook();
    const first = await upload(tenantId, entityId, "first", bytes);
    expect(
      first.status,
      JSON.stringify(await store.listIngestionExceptions(tenantId, first.jobId)),
    ).toBe("posted");
    const before = await closingStatement(tenantId, entityId);
    const replay = await upload(tenantId, entityId, "second", bytes);
    expect(replay.jobId).toBe(first.jobId);
    expect(await closingStatement(tenantId, entityId)).toEqual(before);
    const journals = await store.listJournals(tenantId, entityId, null);
    expect(journals).toHaveLength(2);
    expect(
      journals.filter((journal) => journalKindFromSource(journal.sourceRef) === "opening"),
    ).toHaveLength(1);
    const variance = (await store.listIngestionExceptions(tenantId, first.jobId)).find(
      (exception) => exception.type === "prior_period_variance",
    );
    expect(variance).toBeDefined();
    const rerun = await call(
      app,
      "POST",
      `/ingestion/exceptions/${variance!.exceptionId}/resolve`,
      {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
        body: { action: "accept", note: "Confirm the source balances." },
      },
    );
    expect(rerun.status).toBe(200);
    const rerunJournals = await store.listJournals(tenantId, entityId, null);
    expect(rerunJournals).toHaveLength(2);
    expect(
      rerunJournals.filter((journal) => journalKindFromSource(journal.sourceRef) === "opening"),
    ).toHaveLength(1);
    expect(await closingStatement(tenantId, entityId)).toEqual(before);
  });

  it("blocks a later opening after an earlier standard entry with one plain fix", async () => {
    const { tenantId, entityId } = await company("Late opening");
    const options = { actor: "owner-1", tenant: tenantId, region: "us-east-1" };
    const accounts: string[] = [];
    for (const [code, report, cashFlow, retainedEarnings] of [
      ["cash", "asset", "cash", false],
      ["retained_earnings", "equity", "non_cash", true],
    ] as const) {
      const response = await call(app, "POST", "/v1/accounts", {
        ...options,
        body: { entityId, code, name: code, report, cashFlow, retainedEarnings },
      });
      expect(response.status).toBe(201);
      accounts.push(((await response.json()) as { accountId: string }).accountId);
    }
    const response = await call(app, "POST", "/v1/periods", {
      ...options,
      body: { entityId, startDate: "2025-01-01", endDate: "2025-01-31" },
    });
    expect(response.status).toBe(201);
    const { periodId } = (await response.json()) as { periodId: string };
    const posted = await call(app, "POST", "/v1/journals", {
      ...options,
      idempotency: "earlier",
      body: {
        entityId,
        periodId,
        currency: "USD",
        lines: [
          { accountId: accounts[0], debit: "100.00", credit: "0" },
          { accountId: accounts[1], debit: "0", credit: "100.00" },
        ],
      },
    });
    expect(posted.status).toBe(201);
    const job = await upload(tenantId, entityId, "late");
    expect(job.status).toBe("needs_review");
    expect(await store.listJournals(tenantId, entityId, null)).toHaveLength(1);
    const exceptions = await store.listIngestionExceptions(tenantId, job.jobId);
    const failure = exceptions.find((exception) => exception.type === "model_incomplete");
    expect(failure?.message).toBe(
      "This company already has entries posted before this balance sheet, so it can't be used as opening balances. Upload a balance sheet dated on or before your first posted entry.",
    );
    expect(failure?.message).not.toContain("FIN_");
  });
});

function confirmedDocument(): ParsedDocument {
  const rows = [
    ["balance_sheet", "Cash", "1000.00", "1500.00"],
    ["balance_sheet", "Accounts Payable", "200.00", "200.00"],
    ["balance_sheet", "Retained Earnings", "800.00", "1300.00"],
    ["income_statement", "Revenue", "500.00", "700.00"],
    ["income_statement", "Operating Expenses", "260.00", "200.00"],
  ] as const;
  return {
    parserId: "confirmed-opening-fixture",
    currency: "USD",
    scale: "units",
    issues: [],
    cells: rows.flatMap(([statementType, label, first, last], index) =>
      [
        { periodEnd: "2025-06-30", periodStart: "2025-01-01", amount: first },
        { periodEnd: "2025-12-31", periodStart: "2025-07-01", amount: last },
      ].map(({ periodEnd, periodStart, amount }, column) => ({
        statementType,
        label,
        role: "line" as const,
        sectionId: statementType,
        periodKey: periodEnd,
        periodStart,
        periodEnd,
        spanMonths: 6,
        amount,
        rawText: amount,
        page: null,
        sheet: statementType,
        row: index + 2,
        col: column + 2,
        bbox: null,
        balanceKind:
          statementType === "balance_sheet" ? ("closing" as const) : ("movement" as const),
        currency: "USD",
        scale: "units" as const,
        txnDate: null,
      })),
    ),
  };
}

function workbook(): Uint8Array {
  return writeXlsx(
    [
      {
        name: "Balance Sheet",
        rows: [
          ["Account", "1 January 2025 to 30 June 2025", "1 July 2025 to 31 December 2025"],
          ["Cash", "1000.00", "1500.00"],
          ["Accounts Payable", "200.00", "200.00"],
          ["Retained Earnings", "800.00", "1300.00"],
        ],
      },
      {
        name: "Income Statement",
        rows: [
          ["Account", "1 January 2025 to 30 June 2025", "1 July 2025 to 31 December 2025"],
          ["Revenue", "500.00", "700.00"],
          ["Operating Expenses", "260.00", "200.00"],
        ],
      },
    ].map(({ name, rows }) => ({
      name,
      cells: rows.flatMap((row, i) =>
        row.map((value, j) => ({ row: i + 1, col: j + 1, value, kind: "string" as const })),
      ),
    })),
  );
}
