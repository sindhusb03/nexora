import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

const DCF = {
  currency: "USD",
  freeCashFlows: ["100", "110"],
  wacc: "0.10",
  terminalGrowth: "0.02",
  netDebt: "200",
  nonOperatingAssets: "50",
  otherClaims: "10",
};

describe("program gates", () => {
  let app: TestApp;
  let tenantId = "";
  let entityId = "";
  let periodId = "";
  let cashId = "";

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register(...TEST_ACTORS);
    const provision = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Program Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    tenantId = (await readJson<{ tenantId: string }>(provision)).tenantId;
    const membership = await call(app, "POST", "/v1/memberships", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { actorId: "controller-1", role: "controller" },
    });
    expect(membership.status).toBe(201);
    const entity = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Program Holdings", functionalCurrency: "USD" },
    });
    entityId = (await readJson<{ entityId: string }>(entity)).entityId;
    const period = await call(app, "POST", "/v1/periods", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { entityId, startDate: "2024-01-01", endDate: "2024-12-31" },
    });
    periodId = (await readJson<{ periodId: string }>(period)).periodId;
    const cash = await call(app, "POST", "/v1/accounts", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId,
        code: "1000",
        name: "Cash",
        report: "asset",
        cashFlow: "cash",
        retainedEarnings: false,
      },
    });
    cashId = (await readJson<{ accountId: string }>(cash)).accountId;
    const retained = await call(app, "POST", "/v1/accounts", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId,
        code: "3000",
        name: "Retained earnings",
        report: "equity",
        cashFlow: "non_cash",
        retainedEarnings: true,
      },
    });
    expect(retained.status).toBe(201);
  });

  it("publishes an OpenAPI document from the route schemas", async () => {
    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const body = await readJson<{
      openapi: string;
      components: { schemas: Record<string, { type?: string }> };
    }>(response);
    expect(body.openapi).toBe("3.1.0");
    expect(body.components.schemas.financialState).toBeTruthy();
  });

  it("publishes one hash, blocks the maker, and records lineage", async () => {
    const draft = await state(app, tenantId, entityId, periodId, "Draft view");
    const again = await state(app, tenantId, entityId, periodId, "Published view");
    expect(draft.stateHash).toBe(again.stateHash);
    expect(draft.stateHash).toHaveLength(64);

    const approved = await walk(app, tenantId, draft.financialStateId, "owner-1");
    const blocked = await transition(app, tenantId, approved, "published", "owner-1");
    expect(blocked.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(blocked)).error.code).toBe(
      "PUBLISH_BLOCKED",
    );

    const published = await transition(app, tenantId, approved, "published", "controller-1");
    expect(published.status).toBe(200);
    const publishedBody = await readJson<{
      financialStateId: string;
      stateHash: string;
      status: string;
    }>(published);
    expect(publishedBody.stateHash).toBe(draft.stateHash);
    expect(publishedBody.status).toBe("published");

    const stored = await call(
      app,
      "GET",
      `/v1/financial-states/${publishedBody.financialStateId}`,
      {
        actor: "controller-1",
        tenant: tenantId,
        region: "us-east-1",
      },
    );
    expect(stored.status).toBe(200);
    expect(await readJson<Record<string, unknown>>(stored)).toMatchObject({
      financialStateId: publishedBody.financialStateId,
      status: "published",
      stateHash: draft.stateHash,
      supersedesId: approved,
      makerActorId: "owner-1",
    });

    const lineage = await call(app, "GET", `/v1/lineage/financial_state/${approved}`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(lineage.status).toBe(200);
    const edges = await readJson<{ edges: { toId: string; relation: string }[] }>(lineage);
    expect(
      edges.edges.some(
        (edge) => edge.toId === publishedBody.financialStateId && edge.relation === "supersedes",
      ),
    ).toBe(true);

    const other = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "eu-central-1",
      body: { name: "Other Co", homeRegion: "eu-central-1", ownerActorId: "owner-2" },
    });
    const otherId = (await readJson<{ tenantId: string }>(other)).tenantId;
    const hidden = await call(app, "GET", `/v1/lineage/financial_state/${approved}`, {
      actor: "owner-2",
      tenant: otherId,
      region: "eu-central-1",
    });
    expect(hidden.status).toBe(200);
    expect((await readJson<{ edges: unknown[] }>(hidden)).edges).toEqual([]);

    const region = await call(app, "GET", `/v1/lineage/financial_state/${approved}`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "eu-central-1",
    });
    expect(region.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(region)).error.code).toBe(
      "REGION_MISMATCH",
    );

    return { publishedId: publishedBody.financialStateId, stateHash: publishedBody.stateHash };
  });

  it("refuses a failed valuation and a draft board pack, then freezes a published pack", async () => {
    const failed = await call(app, "POST", "/v1/valuations", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { ...DCF, wacc: "0.02", terminalGrowth: "0.02" },
    });
    expect(failed.status).toBe(201);
    const failedBody = await readJson<{
      valuationId: string;
      calculationStatus: string;
      code: string;
    }>(failed);
    expect(failedBody.calculationStatus).toBe("failed");
    expect(failedBody.code).toBe("VALUATION_INVALID_ASSUMPTION");
    const failedPublish = await transitionValuation(
      app,
      tenantId,
      failedBody.valuationId,
      "published",
      "controller-1",
    );
    expect(failedPublish.status).toBe(409);

    const created = await call(app, "POST", "/v1/valuations", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: DCF,
    });
    expect(created.status).toBe(201);
    const valuation = await readJson<{
      valuationId: string;
      enterpriseValue: string;
      equityValue: string;
      engineVersion: string;
      calculationStatus: string;
    }>(created);
    expect(valuation.enterpriseValue).toBe("1340.909090909091");
    expect(valuation.equityValue).toBe("1180.909090909091");
    expect(valuation.engineVersion).toBe("fe-kernel-0.2.1");
    expect(valuation.calculationStatus).toBe("succeeded");

    const draftPack = await call(app, "POST", "/v1/report-packs", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { statementStateId: valuation.valuationId, valuationId: valuation.valuationId },
    });
    expect(draftPack.status).toBe(404);

    const approved = await walkValuation(app, tenantId, valuation.valuationId, "owner-1");
    const publishedValuation = await transitionValuation(
      app,
      tenantId,
      approved,
      "published",
      "controller-1",
    );
    expect(publishedValuation.status).toBe(200);
    const publishedValuationId = (await readJson<{ valuationId: string }>(publishedValuation))
      .valuationId;

    const storedValuation = await call(app, "GET", `/v1/valuations/${publishedValuationId}`, {
      actor: "controller-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect(storedValuation.status).toBe(200);
    const storedBody = await readJson<Record<string, unknown>>(storedValuation);
    expect(storedBody).toMatchObject({
      valuationId: publishedValuationId,
      status: "published",
      calculationStatus: "succeeded",
      enterpriseValue: "1340.909090909091",
      equityValue: "1180.909090909091",
      makerActorId: "owner-1",
    });
    expect(storedBody).not.toHaveProperty("assumption");

    const sensitivity = await call(
      app,
      "POST",
      `/v1/valuations/${valuation.valuationId}/calculate`,
      {
        actor: "owner-1",
        tenant: tenantId,
        region: "us-east-1",
        body: { shocks: [{ id: "wacc-up", wacc: "0.12" }] },
      },
    );
    expect(sensitivity.status).toBe(200);
    const shocked = await readJson<{
      runs: { id: string; enterpriseValue: string; calculationRunId: string }[];
      engineVersion: string;
    }>(sensitivity);
    expect(shocked.engineVersion).toBe("fe-kernel-0.2.1");
    expect(shocked.runs[0]?.id).toBe("wacc-up");
    expect(shocked.runs[0]?.enterpriseValue).not.toBe("1340.909090909091");
    expect(shocked.runs[0]?.calculationRunId).toBeTruthy();

    const statement = await state(app, tenantId, entityId, periodId, "Board");
    const publishedStatementId = await publishState(app, tenantId, statement.financialStateId);

    const pack = await call(app, "POST", "/v1/report-packs", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { statementStateId: publishedStatementId, valuationId: publishedValuationId },
    });
    expect(pack.status).toBe(201);
    const packBody = await readJson<{
      reportPackId: string;
      stateHash: string;
      engineVersion: string;
    }>(pack);
    const first = await call(app, "GET", `/v1/report-packs/${packBody.reportPackId}`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    const second = await call(app, "GET", `/v1/report-packs/${packBody.reportPackId}`, {
      actor: "controller-1",
      tenant: tenantId,
      region: "us-east-1",
    });
    expect((await readJson<{ stateHash: string }>(first)).stateHash).toBe(packBody.stateHash);
    expect((await readJson<{ stateHash: string }>(second)).stateHash).toBe(packBody.stateHash);

    const failedPack = await call(app, "POST", "/v1/report-packs", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { statementStateId: publishedStatementId, valuationId: failedBody.valuationId },
    });
    expect(failedPack.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(failedPack)).error.code).toBe(
      "PUBLISH_BLOCKED",
    );
  });

  it("translates a group, evaluates a model, and leaves the scenario base unchanged", async () => {
    const group = await call(app, "POST", "/v1/consolidation-groups", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { name: "Group", reportingCurrency: "EUR" },
    });
    const groupId = (await readJson<{ consolidationGroupId: string }>(group)).consolidationGroupId;
    const books = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "FX Books", functionalCurrency: "USD" },
    });
    expect(books.status).toBe(201);
    const booksId = (await readJson<{ entityId: string }>(books)).entityId;
    const booksPeriod = await call(app, "POST", "/v1/periods", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { entityId: booksId, startDate: "2024-01-01", endDate: "2024-12-31" },
    });
    expect(booksPeriod.status).toBe(201);
    const booksPeriodId = (await readJson<{ periodId: string }>(booksPeriod)).periodId;
    const bookCash = await call(app, "POST", "/v1/accounts", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId: booksId,
        code: "1000",
        name: "Cash",
        report: "asset",
        cashFlow: "cash",
        retainedEarnings: false,
      },
    });
    const bookEquity = await call(app, "POST", "/v1/accounts", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId: booksId,
        code: "3100",
        name: "Equity",
        report: "equity",
        cashFlow: "non_cash",
        retainedEarnings: true,
      },
    });
    expect(bookCash.status).toBe(201);
    expect(bookEquity.status).toBe(201);
    const bookCashId = (await readJson<{ accountId: string }>(bookCash)).accountId;
    const bookEquityId = (await readJson<{ accountId: string }>(bookEquity)).accountId;
    const posted = await call(app, "POST", "/v1/journals", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: crypto.randomUUID(),
      body: {
        entityId: booksId,
        periodId: booksPeriodId,
        currency: "USD",
        lines: [
          { accountId: bookCashId, debit: "100", credit: "0" },
          { accountId: bookEquityId, debit: "0", credit: "100" },
        ],
      },
    });
    expect(posted.status).toBe(201);
    const rate = (value: string) => ({
      rateSetId: "rates-2024",
      base: "USD",
      quote: "EUR",
      rate: value,
      rounding: "half_even" as const,
    });
    const rates = [
      {
        sourceCurrency: "USD",
        closing: rate("0.90"),
        historical: rate("0.80"),
        average: rate("0.85"),
      },
    ];
    const translated = await call(app, "POST", `/v1/consolidation-groups/${groupId}/translate`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        ctaAccountId: "cta",
        entities: [{ entityId: booksId, periodId: booksPeriodId }],
        rates,
      },
    });
    expect(translated.status).toBe(200);
    const fx = await readJson<{
      ctaMinor: string;
      lines: { accountId: string; debitPositiveMinor: string }[];
      engineVersion: string;
    }>(translated);
    expect(fx.ctaMinor).toBe("-1000");
    expect(fx.engineVersion).toBe("fe-kernel-0.2.1");
    const translatedLines = new Map(
      fx.lines.map((line) => [line.accountId, line.debitPositiveMinor]),
    );
    expect(translatedLines.get(bookCashId)).toBe("9000");
    expect(translatedLines.get(bookEquityId)).toBe("-8000");
    expect(translatedLines.get("cta")).toBe("-1000");
    expect(fx.lines.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n)).toBe(0n);

    const eliminated = await call(app, "POST", `/v1/consolidation-groups/${groupId}/eliminate`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        evidenceId: "ic-1",
        ctaAccountId: "cta",
        entities: [{ entityId: booksId, periodId: booksPeriodId }],
        rates,
        eliminations: [
          { accountId: "ar", debitMinor: "0", creditMinor: "40", evidenceId: "ic-1" },
          { accountId: "ap", debitMinor: "40", creditMinor: "0", evidenceId: "ic-1" },
        ],
      },
    });
    expect(eliminated.status).toBe(200);

    const child = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName: "Program Sub", functionalCurrency: "USD" },
    });
    const childId = (await readJson<{ entityId: string }>(child)).entityId;
    const ownership = await call(app, "POST", "/v1/ownership", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        asOf: "2024-12-31",
        parentEntityId: entityId,
        childEntityId: childId,
        effectiveFrom: "2024-01-01",
        effectiveTo: null,
        percent: "0.60",
        subsidiaryEquityMinor: "-100000",
      },
    });
    expect(ownership.status).toBe(201);
    const nci = await readJson<{ parentEquityMinor: string; nciMinor: string }>(ownership);
    expect(nci.parentEquityMinor).toBe("-60000");
    expect(nci.nciMinor).toBe("-40000");

    const model = await call(app, "POST", "/v1/models", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { name: "Plan" },
    });
    const modelId = (await readJson<{ modelId: string }>(model)).modelId;
    const nodes = [
      { id: "y1", type: "timeseries", values: ["10", "12"], period: "0" },
      { id: "y2", type: "timeseries", values: ["10", "12"], period: "1" },
      { id: "linked", type: "link", ref: "y2" },
      { id: "total", type: "aggregate", op: "sum", refs: ["y1", "linked"] },
      { id: "out", type: "output", ref: "total" },
    ];
    const version = await call(app, "POST", `/v1/models/${modelId}/versions`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { nodes },
    });
    expect(version.status).toBe(201);
    const versionBody = await readJson<{ modelVersionId: string; inputHash: string }>(version);
    const calculated = await call(app, "POST", `/v1/models/${modelId}/calculate`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { nodes },
    });
    const calc = await readJson<{
      outputs: Record<string, string>;
      inputHash: string;
      engineVersion: string;
    }>(calculated);
    expect(calc.outputs.out).toBe("22.000000000000");
    expect(calc.engineVersion).toBe("fe-kernel-0.2.1");

    const scenario = await call(app, "POST", "/v1/scenarios", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        baseVersionId: versionBody.modelVersionId,
        name: "Downside",
        base: { growth: "0.05", price: "10" },
        overrides: { growth: "0.01" },
      },
    });
    expect(scenario.status).toBe(201);
    const scenarioBody = await readJson<{ base: { growth: string }; scenario: { growth: string } }>(
      scenario,
    );
    expect(scenarioBody.base.growth).toBe("0.05");
    expect(scenarioBody.scenario.growth).toBe("0.01");
    expect(calc.inputHash).toBe(versionBody.inputHash);
  });

  it("ties capital, imports once, discards uncited numbers, and maps a basis", async () => {
    const debt = await call(app, "POST", "/v1/capital/debt", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId,
        name: "Term loan",
        openingMinor: "100000",
        drawMinor: "20000",
        repaymentMinor: "5000",
        accruedInterestMinor: "1000",
      },
    });
    expect(debt.status).toBe(201);
    expect(
      (await readJson<{ closingMinor: string; engineVersion: string }>(debt)).closingMinor,
    ).toBe("116000");

    const cap = await call(app, "POST", "/v1/capital/cap-table", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId,
        holdings: [
          { holderId: "a", commonShares: "60", options: "0", convertibles: "0" },
          { holderId: "b", commonShares: "40", options: "0", convertibles: "0" },
        ],
      },
    });
    expect((await readJson<{ fullyDilutedShares: string }>(cap)).fullyDilutedShares).toBe("100");

    const tied = await call(app, "POST", "/v1/capital/sources-uses", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        sources: [
          { label: "equity", amountMinor: "40000" },
          { label: "debt", amountMinor: "20000" },
        ],
        uses: [{ label: "purchase", amountMinor: "60000" }],
      },
    });
    expect(tied.status).toBe(200);
    const gap = await call(app, "POST", "/v1/capital/sources-uses", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        sources: [{ label: "equity", amountMinor: "1" }],
        uses: [{ label: "purchase", amountMinor: "2" }],
      },
    });
    expect(gap.status).toBe(422);

    const lbo = await call(app, "POST", "/v1/capital/lbo", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { entryEquity: "100", exitEquity: "200", holdYears: "5" },
    });
    expect(lbo.status).toBe(200);
    expect((await readJson<{ engineVersion: string }>(lbo)).engineVersion).toBe("fe-kernel-0.2.1");

    const rows = [{ rowNo: 1, account: "1000", amount: "500.00" }];
    const imported = await call(app, "POST", "/v1/imports", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: "file-1",
      body: { rows },
    });
    expect(imported.status).toBe(201);
    const batch = await readJson<{ importBatchId: string; fileHash: string }>(imported);
    const replay = await call(app, "POST", "/v1/imports", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: "file-1",
      body: { rows },
    });
    expect(replay.status).toBe(200);
    expect(
      (await readJson<{ importBatchId: string; replayed: boolean }>(replay)).importBatchId,
    ).toBe(batch.importBatchId);
    const clash = await call(app, "POST", "/v1/imports", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: "file-1",
      body: { rows: [{ rowNo: 1, account: "1000", amount: "1.00" }] },
    });
    expect(clash.status).toBe(409);

    const qoe = await call(app, "POST", "/v1/qoe", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        reported: "100",
        adjustments: [{ adjustmentId: "a1", sourceRowId: batch.importBatchId, amount: "15" }],
      },
    });
    expect((await readJson<{ normalized: string; engineVersion: string }>(qoe)).normalized).toBe(
      "115.000000000000",
    );

    const proposal = await call(app, "POST", "/v1/proposals", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { claims: [{ text: "EBITDA is 115", citationId: null }] },
    });
    expect(proposal.status).toBe(201);
    const suggested = await readJson<{ refusal: string; discarded: { text: string }[] }>(proposal);
    expect(suggested.refusal).toContain("discarded");
    expect(suggested.discarded[0]?.text).toBe("EBITDA is 115");

    const unbalanced = await call(app, "POST", "/v1/proposals/accept", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        entityId,
        periodId,
        currency: "USD",
        lines: [
          { accountId: cashId, debitMinor: "1000", creditMinor: "0" },
          { accountId: cashId, debitMinor: "0", creditMinor: "900" },
        ],
      },
    });
    expect(unbalanced.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(unbalanced)).error.code).toBe(
      "FIN_UNBALANCED_JOURNAL",
    );

    const published = await state(app, tenantId, entityId, periodId, "Deal");
    const deal = await call(app, "POST", "/v1/deals", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        publishedStateHash: published.stateHash,
        base: { growth: "0.05", price: "10" },
        overrides: { growth: "0.01" },
      },
    });
    expect(deal.status).toBe(201);
    const dealBody = await readJson<{
      base: { growth: string };
      scenario: { growth: string };
      outputHash: string;
    }>(deal);
    expect(dealBody.base.growth).toBe("0.05");
    expect(dealBody.scenario.growth).toBe("0.01");
    expect(dealBody.outputHash).toHaveLength(64);

    const basis = await call(app, "POST", "/v1/reporting-bases", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: {
        basisVersion: "local-gaap-2024",
        localBalances: [{ accountId: "local-cash", debitPositiveMinor: "100" }],
        mappings: [{ localAccountId: "local-cash", groupAccountId: "group-cash" }],
      },
    });
    expect(basis.status).toBe(201);
    const mapped = await readJson<{ localHash: string; groupHash: string }>(basis);
    expect(mapped.localHash).not.toBe(mapped.groupHash);
    expect(mapped.localHash).toHaveLength(64);
  });
});

async function state(
  app: TestApp,
  tenantId: string,
  entityId: string,
  periodId: string,
  label: string,
) {
  const response = await call(app, "POST", "/v1/financial-states", {
    actor: "owner-1",
    tenant: tenantId,
    region: "us-east-1",
    body: { entityId, periodId, basis: "us-gaap", label },
  });
  expect(response.status).toBe(201);
  return readJson<{ financialStateId: string; stateHash: string }>(response);
}

async function transition(app: TestApp, tenantId: string, id: string, to: string, actor: string) {
  return call(app, "POST", `/v1/financial-states/${id}/transition`, {
    actor,
    tenant: tenantId,
    region: "us-east-1",
    body: { to },
  });
}

async function transitionValuation(
  app: TestApp,
  tenantId: string,
  id: string,
  to: string,
  actor: string,
) {
  return call(app, "POST", `/v1/valuations/${id}/transition`, {
    actor,
    tenant: tenantId,
    region: "us-east-1",
    body: { to },
  });
}

async function walk(app: TestApp, tenantId: string, id: string, actor: string) {
  let current = id;
  for (const to of ["validated", "review", "approved"] as const) {
    const response = await transition(app, tenantId, current, to, actor);
    expect(response.status).toBe(200);
    current = (await readJson<{ financialStateId: string }>(response)).financialStateId;
  }
  return current;
}

async function walkValuation(app: TestApp, tenantId: string, id: string, actor: string) {
  let current = id;
  for (const to of ["validated", "review", "approved"] as const) {
    const response = await transitionValuation(app, tenantId, current, to, actor);
    expect(response.status).toBe(200);
    current = (await readJson<{ valuationId: string }>(response)).valuationId;
  }
  return current;
}

async function publishState(app: TestApp, tenantId: string, id: string) {
  const approved = await walk(app, tenantId, id, "owner-1");
  const published = await transition(app, tenantId, approved, "published", "controller-1");
  expect(published.status).toBe(200);
  return (await readJson<{ financialStateId: string }>(published)).financialStateId;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
