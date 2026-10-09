import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

/**
 * Golden fixture `two_entity_fx`.
 * Formula: current-rate-by-report-class-v1. Engine: fe-kernel-0.2.1.
 * Amounts are integer minor units. Balance-sheet accounts are cumulative through
 * the period end. Income is current-period movement. Prior income rolls into retained earnings.
 *
 * US 2023 opening (USD minor):
 *   Dr Cash 100,000,000, Cr Equity 100,000,000
 *   Dr Expense 2,000, Cr Cash 2,000 → expense opening rolls into retained earnings
 * US 2024 movement: Dr Cash 9,000, Dr AR 1,000, Cr Equity 10,000
 * US closing: Cash 100,007,000, AR 1,000, Equity -100,010,000, RE 2,000
 *   Closing 0.90, historical 0.80 → Cash 90,006,300, AR 900, Equity -80,008,000, RE 1,600, CTA -10,000,800
 * UK 2024 only (GBP minor): Cash 5,000, AP -750, Equity -4,250
 *   Closing 1.20, historical 1.10 → Cash 6,000, AP -900, Equity -4,675, CTA -425
 * Group EUR CTA -10,001,225. Elimination clears AR 900 against AP 900. The total is zero.
 */

const ENGINE_VERSION = "fe-kernel-0.2.1";
const FORMULA_VERSION = "current-rate-by-report-class-v1";

describe("posted-ledger group consolidation", () => {
  let app: TestApp;
  let tenantId = "";
  let groupId = "";
  let usEntityId = "";
  let ukEntityId = "";
  let usPeriodId = "";
  let ukPeriodId = "";
  let usPriorPeriodId = "";
  let usCash = "";
  let usAr = "";
  let usEquity = "";
  let usRe = "";
  let ukCash = "";
  let ukAp = "";
  let ukEquity = "";

  const rates = [
    {
      sourceCurrency: "USD",
      closing: fx("USD", "0.90", "rates-usd-2024"),
      historical: fx("USD", "0.80", "rates-usd-2024"),
      average: fx("USD", "0.85", "rates-usd-2024"),
    },
    {
      sourceCurrency: "GBP",
      closing: fx("GBP", "1.20", "rates-gbp-2024"),
      historical: fx("GBP", "1.10", "rates-gbp-2024"),
      average: fx("GBP", "1.15", "rates-gbp-2024"),
    },
  ];

  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register(...TEST_ACTORS);
    const provision = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Consolidation Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    tenantId = (await readJson<{ tenantId: string }>(provision)).tenantId;

    const group = await call(app, "POST", "/v1/consolidation-groups", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { name: "Two entity FX", reportingCurrency: "EUR" },
    });
    groupId = (await readJson<{ consolidationGroupId: string }>(group)).consolidationGroupId;

    usEntityId = await createEntity("US Holdco", "USD");
    ukEntityId = await createEntity("UK Sub", "GBP");
    usPeriodId = await createPeriod(usEntityId, "2024-01-01", "2024-12-31");
    ukPeriodId = await createPeriod(ukEntityId, "2024-01-01", "2024-12-31");
    usPriorPeriodId = await createPeriod(usEntityId, "2023-01-01", "2023-12-31");

    usCash = await createAccount(usEntityId, "1000", "Cash", "asset", "cash", false);
    usAr = await createAccount(
      usEntityId,
      "1200",
      "Intercompany receivable",
      "asset",
      "non_cash",
      false,
    );
    usEquity = await createAccount(usEntityId, "3000", "Equity", "equity", "non_cash", false);
    usRe = await createAccount(usEntityId, "3900", "Retained earnings", "equity", "non_cash", true);
    const usExpense = await createAccount(usEntityId, "5000", "Expense", "expense", "cfo", false);
    ukCash = await createAccount(ukEntityId, "1000", "Cash", "asset", "cash", false);
    ukAp = await createAccount(
      ukEntityId,
      "2100",
      "Intercompany payable",
      "liability",
      "non_cash",
      false,
    );
    ukEquity = await createAccount(ukEntityId, "3000", "Equity", "equity", "non_cash", false);
    await createAccount(ukEntityId, "3900", "Retained earnings", "equity", "non_cash", true);

    await post(usEntityId, usPeriodId, "USD", [
      { accountId: usCash, debit: "90", credit: "0" },
      { accountId: usAr, debit: "10", credit: "0" },
      { accountId: usEquity, debit: "0", credit: "100" },
    ]);
    await post(ukEntityId, ukPeriodId, "GBP", [
      { accountId: ukCash, debit: "50", credit: "0" },
      { accountId: ukAp, debit: "0", credit: "7.50" },
      { accountId: ukEquity, debit: "0", credit: "42.50" },
    ]);
    await post(usEntityId, usPriorPeriodId, "USD", [
      { accountId: usCash, debit: "1000000", credit: "0" },
      { accountId: usEquity, debit: "0", credit: "1000000" },
    ]);
    await post(usEntityId, usPriorPeriodId, "USD", [
      { accountId: usExpense, debit: "20", credit: "0" },
      { accountId: usCash, debit: "0", credit: "20" },
    ]);
  });

  it("pins the consolidated translation and elimination from posted entries", async () => {
    const translated = await translate(ledgerBody());
    expect(translated.status).toBe(200);
    const fx = await readJson<TranslationBody>(translated);
    expect(fx.engineVersion).toBe(ENGINE_VERSION);
    expect(fx.formulaVersion).toBe(FORMULA_VERSION);
    expect(fx.groupCurrency).toBe("EUR");
    expect(fx.ctaMinor).toBe("-10001225");
    expect(lineMap(fx.lines)).toEqual(
      new Map([
        [usCash, "90006300"],
        [usAr, "900"],
        [usEquity, "-80008000"],
        [usRe, "1600"],
        [ukCash, "6000"],
        [ukAp, "-900"],
        [ukEquity, "-4675"],
        ["cta", "-10001225"],
      ]),
    );
    expect(fx.lines.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n)).toBe(0n);

    const eliminated = await eliminate({
      ...ledgerBody(),
      evidenceId: "ic-2024",
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "900", evidenceId: "ic-2024" },
        { accountId: ukAp, debitMinor: "900", creditMinor: "0", evidenceId: "ic-2024" },
      ],
    });
    expect(eliminated.status).toBe(200);
    const elimination = await readJson<EliminationBody>(eliminated);
    expect(elimination.engineVersion).toBe(ENGINE_VERSION);
    expect(elimination.formulaVersion).toBe(FORMULA_VERSION);
    expect(elimination.groupCurrency).toBe("EUR");
    expect(lineMap(elimination.balances)).toEqual(
      new Map([
        [usCash, "90006300"],
        [usAr, "0"],
        [usEquity, "-80008000"],
        [usRe, "1600"],
        [ukCash, "6000"],
        [ukAp, "0"],
        [ukEquity, "-4675"],
        ["cta", "-10001225"],
      ]),
    );
    expect(
      elimination.balances.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n),
    ).toBe(0n);
  });

  it("rejects a tampered caller-supplied balance without changing the posted result", async () => {
    const clean = await translate(ledgerBody());
    const pinned = await readJson<TranslationBody>(clean);
    expect(pinned.ctaMinor).toBe("-10001225");

    const tampered = await translate({
      ...ledgerBody(),
      sourceCurrency: "JPY",
      lines: [{ accountId: usCash, rateType: "closing", debitPositiveMinor: "999999" }],
      balances: [{ accountId: usCash, debitPositiveMinor: "999999" }],
    });
    expect(tampered.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(tampered)).error.code).toBe(
      "CALLER_TRIAL_BALANCE_REJECTED",
    );

    const again = await translate(ledgerBody());
    const repeated = await readJson<TranslationBody>(again);
    expect(repeated.ctaMinor).toBe(pinned.ctaMinor);
    expect(repeated.lines).toEqual(pinned.lines);
    expect(repeated.inputHash).toBe(pinned.inputHash);
    expect(repeated.outputHash).toBe(pinned.outputHash);

    const eliminated = await eliminate({
      ...ledgerBody(),
      evidenceId: "ic-2024",
      balances: [{ accountId: usCash, debitPositiveMinor: "999999" }],
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "900", evidenceId: "ic-2024" },
        { accountId: ukAp, debitMinor: "900", creditMinor: "0", evidenceId: "ic-2024" },
      ],
    });
    expect(eliminated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(eliminated)).error.code).toBe(
      "CALLER_TRIAL_BALANCE_REJECTED",
    );

    const eliminatedAgain = await eliminate({
      ...ledgerBody(),
      evidenceId: "ic-2024",
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "900", evidenceId: "ic-2024" },
        { accountId: ukAp, debitMinor: "900", creditMinor: "0", evidenceId: "ic-2024" },
      ],
    });
    const elimination = await readJson<EliminationBody>(eliminatedAgain);
    expect(lineMap(elimination.balances).get(usCash)).toBe("90006300");
    expect(lineMap(elimination.balances).get(usRe)).toBe("1600");
    expect(lineMap(elimination.balances).get(usAr)).toBe("0");
    expect(
      elimination.balances.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n),
    ).toBe(0n);
  });

  it("rejects an entity that has no retained earnings account", async () => {
    const entityId = await createEntity("No retained earnings", "USD");
    const periodId = await createPeriod(entityId, "2024-01-01", "2024-12-31");
    const cash = await createAccount(entityId, "1000", "Cash", "asset", "cash", false);
    const equity = await createAccount(entityId, "3000", "Equity", "equity", "non_cash", false);
    await post(entityId, periodId, "USD", [
      { accountId: cash, debit: "10", credit: "0" },
      { accountId: equity, debit: "0", credit: "10" },
    ]);
    const response = await translate({
      ctaAccountId: "cta",
      entities: [{ entityId, periodId }],
      rates: [rates[0]],
    });
    expect(response.status).toBe(422);
    const body = await readJson<{ error: { code: string; message: string } }>(response);
    expect(body.error.code).toBe("FIN_STATEMENT_IMBALANCE");
    expect(body.error.message).toBe("Entity has no retained earnings account");
  });

  it("rejects an entity or period from another tenant", async () => {
    const foreignTenant = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: {
        name: "Other consolidation tenant",
        homeRegion: "us-east-1",
        ownerActorId: "owner-2",
      },
    });
    const foreignTenantId = (await readJson<{ tenantId: string }>(foreignTenant)).tenantId;
    const foreignEntity = await call(app, "POST", "/v1/entities", {
      actor: "owner-2",
      tenant: foreignTenantId,
      region: "us-east-1",
      body: { legalName: "Foreign books", functionalCurrency: "USD" },
    });
    const foreignEntityId = (await readJson<{ entityId: string }>(foreignEntity)).entityId;
    const foreignPeriod = await call(app, "POST", "/v1/periods", {
      actor: "owner-2",
      tenant: foreignTenantId,
      region: "us-east-1",
      body: { entityId: foreignEntityId, startDate: "2024-01-01", endDate: "2024-12-31" },
    });
    const foreignPeriodId = (await readJson<{ periodId: string }>(foreignPeriod)).periodId;

    const entity = await translate({
      ...ledgerBody(),
      entities: [
        { entityId: foreignEntityId, periodId: usPeriodId },
        { entityId: ukEntityId, periodId: ukPeriodId },
      ],
    });
    expect(entity.status).toBe(404);
    expect((await readJson<{ error: { code: string } }>(entity)).error.code).toBe("FIN_NOT_FOUND");

    const period = await translate({
      ...ledgerBody(),
      entities: [
        { entityId: usEntityId, periodId: foreignPeriodId },
        { entityId: ukEntityId, periodId: ukPeriodId },
      ],
    });
    expect(period.status).toBe(404);
    expect((await readJson<{ error: { code: string } }>(period)).error.code).toBe("FIN_NOT_FOUND");
  });

  it("rejects a period that belongs to another entity", async () => {
    const response = await translate({
      ...ledgerBody(),
      entities: [
        { entityId: usEntityId, periodId: ukPeriodId },
        { entityId: ukEntityId, periodId: ukPeriodId },
      ],
    });
    expect(response.status).toBe(404);
    expect(
      (await readJson<{ error: { code: string; message: string } }>(response)).error.message,
    ).toBe("Period does not belong to the entity");
  });

  it("rejects periods that do not share an end date", async () => {
    const scope = {
      ...ledgerBody(),
      entities: [
        { entityId: usEntityId, periodId: usPriorPeriodId },
        { entityId: ukEntityId, periodId: ukPeriodId },
      ],
    };
    const translated = await translate(scope);
    expect(translated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(translated)).error.code).toBe(
      "FIN_INVALID_PERIOD",
    );
    const eliminated = await eliminate({
      ...scope,
      evidenceId: "ic-scope",
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "1", evidenceId: "ic-scope" },
        { accountId: ukAp, debitMinor: "1", creditMinor: "0", evidenceId: "ic-scope" },
      ],
    });
    expect(eliminated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(eliminated)).error.code).toBe(
      "FIN_INVALID_PERIOD",
    );
  });

  it("rejects a quarter and a full year that end on the same day", async () => {
    const entityId = await createEntity("Q4 books", "USD");
    const quarter = await createPeriod(entityId, "2024-10-01", "2024-12-31");
    const cash = await createAccount(entityId, "1000", "Cash", "asset", "cash", false);
    const equity = await createAccount(entityId, "3000", "Equity", "equity", "non_cash", false);
    await createAccount(entityId, "3900", "Retained earnings", "equity", "non_cash", true);
    await post(entityId, quarter, "USD", [
      { accountId: cash, debit: "10", credit: "0" },
      { accountId: equity, debit: "0", credit: "10" },
    ]);
    const scope = {
      ...ledgerBody(),
      entities: [
        { entityId: usEntityId, periodId: usPeriodId },
        { entityId, periodId: quarter },
      ],
    };
    const translated = await translate(scope);
    expect(translated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(translated)).error.code).toBe(
      "FIN_INVALID_PERIOD",
    );
    const eliminated = await eliminate({
      ...scope,
      evidenceId: "ic-span",
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "1", evidenceId: "ic-span" },
        { accountId: ukAp, debitMinor: "1", creditMinor: "0", evidenceId: "ic-span" },
      ],
    });
    expect(eliminated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(eliminated)).error.code).toBe(
      "FIN_INVALID_PERIOD",
    );
  });

  it("rejects a duplicate entity in the scope", async () => {
    const scope = {
      ...ledgerBody(),
      entities: [
        { entityId: usEntityId, periodId: usPeriodId },
        { entityId: usEntityId, periodId: usPeriodId },
      ],
    };
    const translated = await translate(scope);
    expect(translated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(translated)).error.code).toBe(
      "FIN_INVALID_JOURNAL_LINE",
    );
    const eliminated = await eliminate({
      ...scope,
      evidenceId: "ic-scope",
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "1", evidenceId: "ic-scope" },
        { accountId: ukAp, debitMinor: "1", creditMinor: "0", evidenceId: "ic-scope" },
      ],
    });
    expect(eliminated.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(eliminated)).error.code).toBe(
      "FIN_INVALID_JOURNAL_LINE",
    );
  });

  it("rejects an elimination account outside the consolidated lines", async () => {
    const unknown = await eliminate({
      ...ledgerBody(),
      evidenceId: "ic-account",
      eliminations: [
        {
          accountId: "not-a-consolidated-account",
          debitMinor: "1",
          creditMinor: "0",
          evidenceId: "ic-account",
        },
        { accountId: ukAp, debitMinor: "0", creditMinor: "1", evidenceId: "ic-account" },
      ],
    });
    expect(unknown.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(unknown)).error.code).toBe(
      "FIN_INVALID_JOURNAL_LINE",
    );
    const cta = await eliminate({
      ...ledgerBody(),
      evidenceId: "ic-cta",
      eliminations: [
        { accountId: "cta", debitMinor: "1", creditMinor: "0", evidenceId: "ic-cta" },
        { accountId: ukAp, debitMinor: "0", creditMinor: "1", evidenceId: "ic-cta" },
      ],
    });
    expect(cta.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(cta)).error.code).toBe(
      "FIN_INVALID_JOURNAL_LINE",
    );
  });

  it("rejects an elimination evidence id that differs from the request", async () => {
    const response = await eliminate({
      ...ledgerBody(),
      evidenceId: "ic-match",
      eliminations: [
        { accountId: usAr, debitMinor: "0", creditMinor: "1", evidenceId: "ic-other" },
        { accountId: ukAp, debitMinor: "1", creditMinor: "0", evidenceId: "ic-match" },
      ],
    });
    expect(response.status).toBe(422);
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      "FIN_INVALID_JOURNAL_LINE",
    );
  });

  it("rejects a CTA account that matches any entity account in the scope", async () => {
    const response = await translate({ ...ledgerBody(), ctaAccountId: usCash });
    expect(response.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      "FX_INVALID_RATE",
    );
  });

  it("rejects an identity rate other than 1 and defaults a missing identity triple to 1", async () => {
    const entityId = await createEntity("EUR books", "EUR");
    const periodId = await createPeriod(entityId, "2024-01-01", "2024-12-31");
    const cash = await createAccount(entityId, "1000", "Cash", "asset", "cash", false);
    const equity = await createAccount(entityId, "3000", "Equity", "equity", "non_cash", false);
    await createAccount(entityId, "3900", "Retained earnings", "equity", "non_cash", true);
    await post(entityId, periodId, "EUR", [
      { accountId: cash, debit: "10", credit: "0" },
      { accountId: equity, debit: "0", credit: "10" },
    ]);
    const identity = (value: string) => ({
      rateSetId: "eur-identity",
      base: "EUR",
      quote: "EUR",
      rate: value,
      rounding: "half_even" as const,
    });
    const rejected = await translate({
      ctaAccountId: "cta",
      entities: [{ entityId, periodId }],
      rates: [
        {
          sourceCurrency: "EUR",
          closing: identity("1.10"),
          historical: identity("1.10"),
          average: identity("1.10"),
        },
      ],
    });
    expect(rejected.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(rejected)).error.code).toBe(
      "FX_INVALID_RATE",
    );
    const translated = await translate({
      ctaAccountId: "cta",
      entities: [{ entityId, periodId }],
      rates: [rates[0]],
    });
    expect(translated.status).toBe(200);
    const fx = await readJson<TranslationBody>(translated);
    expect(lineMap(fx.lines)).toEqual(
      new Map([
        [cash, "1000"],
        [equity, "-1000"],
        ["cta", "0"],
      ]),
    );
  });

  it("rounds a half-even tie and pins the CTA", async () => {
    const entityId = await createEntity("Tie books", "USD");
    const periodId = await createPeriod(entityId, "2024-01-01", "2024-12-31");
    const cash = await createAccount(entityId, "1000", "Cash", "asset", "cash", false);
    const equity = await createAccount(entityId, "3000", "Equity", "equity", "non_cash", false);
    await createAccount(entityId, "3900", "Retained earnings", "equity", "non_cash", true);
    await post(entityId, periodId, "USD", [
      { accountId: cash, debit: "0.15", credit: "0" },
      { accountId: equity, debit: "0", credit: "0.15" },
    ]);
    const translated = await translate({
      ctaAccountId: "cta",
      entities: [{ entityId, periodId }],
      rates: [rates[0]],
    });
    expect(translated.status).toBe(200);
    const fx = await readJson<TranslationBody>(translated);
    // 15 USD minor × 0.90 = 0.135 EUR, half-even to 14 minor. Equity × 0.80 is 12 minor. CTA is -2.
    expect(lineMap(fx.lines)).toEqual(
      new Map([
        [cash, "14"],
        [equity, "-12"],
        ["cta", "-2"],
      ]),
    );
    expect(fx.ctaMinor).toBe("-2");
    expect(fx.lines.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n)).toBe(0n);
  });

  it("rejects an unknown translate field without treating it as a trial balance", async () => {
    const response = await translate({ ...ledgerBody(), note: "extra" });
    expect(response.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("rejects a missing rate triple", async () => {
    const response = await translate({
      ...ledgerBody(),
      rates: rates.filter((rate) => rate.sourceCurrency === "USD"),
    });
    expect(response.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(response)).error.code).toBe(
      "FX_RATE_MISSING",
    );
  });

  it("keeps a later period out of the 2024 consolidation", async () => {
    const later = await createPeriod(usEntityId, "2025-01-01", "2025-12-31");
    await post(usEntityId, later, "USD", [
      { accountId: usCash, debit: "500", credit: "0" },
      { accountId: usEquity, debit: "0", credit: "500" },
    ]);
    const translated = await translate(ledgerBody());
    expect(translated.status).toBe(200);
    const fx = await readJson<TranslationBody>(translated);
    const lines = lineMap(fx.lines);
    expect(lines.get(usCash)).toBe("90006300");
    expect(lines.get(usEquity)).toBe("-80008000");
    expect(fx.ctaMinor).toBe("-10001225");
  });

  it("splits prior and current income between retained earnings and the income account", async () => {
    const entityId = await createEntity("Income split", "USD");
    const prior = await createPeriod(entityId, "2023-01-01", "2023-12-31");
    const current = await createPeriod(entityId, "2024-01-01", "2024-12-31");
    const cash = await createAccount(entityId, "1000", "Cash", "asset", "cash", false);
    const revenue = await createAccount(entityId, "4000", "Revenue", "revenue", "cfo", false);
    const retained = await createAccount(
      entityId,
      "3900",
      "Retained earnings",
      "equity",
      "non_cash",
      true,
    );
    await post(entityId, prior, "USD", [
      { accountId: cash, debit: "100", credit: "0" },
      { accountId: revenue, debit: "0", credit: "100" },
    ]);
    await post(entityId, current, "USD", [
      { accountId: cash, debit: "40", credit: "0" },
      { accountId: revenue, debit: "0", credit: "40" },
    ]);
    const translated = await translate({
      ctaAccountId: "cta",
      entities: [{ entityId, periodId: current }],
      rates: [rates[0]],
    });
    expect(translated.status).toBe(200);
    const fx = await readJson<TranslationBody>(translated);
    expect(lineMap(fx.lines)).toEqual(
      new Map([
        [cash, "12600"],
        [revenue, "-3400"],
        [retained, "-8000"],
        ["cta", "-1200"],
      ]),
    );
    expect(fx.lines.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n)).toBe(0n);
  });

  function ledgerBody() {
    return {
      ctaAccountId: "cta",
      entities: [
        { entityId: usEntityId, periodId: usPeriodId },
        { entityId: ukEntityId, periodId: ukPeriodId },
      ],
      rates,
    };
  }

  function translate(body: unknown) {
    return call(app, "POST", `/v1/consolidation-groups/${groupId}/translate`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body,
    });
  }

  function eliminate(body: unknown) {
    return call(app, "POST", `/v1/consolidation-groups/${groupId}/eliminate`, {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body,
    });
  }

  async function createEntity(legalName: string, functionalCurrency: string) {
    const response = await call(app, "POST", "/v1/entities", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { legalName, functionalCurrency },
    });
    expect(response.status).toBe(201);
    return (await readJson<{ entityId: string }>(response)).entityId;
  }

  async function createPeriod(entityId: string, startDate: string, endDate: string) {
    const response = await call(app, "POST", "/v1/periods", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { entityId, startDate, endDate },
    });
    expect(response.status).toBe(201);
    return (await readJson<{ periodId: string }>(response)).periodId;
  }

  async function createAccount(
    entityId: string,
    code: string,
    name: string,
    report: string,
    cashFlow: string,
    retainedEarnings: boolean,
  ) {
    const response = await call(app, "POST", "/v1/accounts", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { entityId, code, name, report, cashFlow, retainedEarnings },
    });
    expect(response.status).toBe(201);
    return (await readJson<{ accountId: string }>(response)).accountId;
  }

  async function post(
    entityId: string,
    periodId: string,
    currency: string,
    lines: readonly { accountId: string; debit: string; credit: string }[],
  ) {
    const response = await call(app, "POST", "/v1/journals", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      idempotency: crypto.randomUUID(),
      body: { entityId, periodId, currency, lines },
    });
    expect(response.status).toBe(201);
  }
});

function fx(base: string, rate: string, rateSetId: string) {
  return { rateSetId, base, quote: "EUR", rate, rounding: "half_even" as const };
}

function lineMap(lines: readonly { accountId: string; debitPositiveMinor: string }[]) {
  return new Map(lines.map((line) => [line.accountId, line.debitPositiveMinor]));
}

interface TranslationBody {
  readonly engineVersion: string;
  readonly formulaVersion: string;
  readonly groupCurrency: string;
  readonly ctaMinor: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly lines: { accountId: string; debitPositiveMinor: string }[];
}

interface EliminationBody {
  readonly engineVersion: string;
  readonly formulaVersion: string;
  readonly groupCurrency: string;
  readonly balances: { accountId: string; debitPositiveMinor: string }[];
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
