import { beforeAll, describe, expect, it } from "vitest";

import { call, sessions, TEST_ACTORS, testApp, type TestApp } from "./harness.js";

/**
 * Golden fixture `two_entity_fx`.
 * Formula: current-rate-by-report-class-v1. Engine: fe-kernel-0.2.1.
 * Amounts are integer minor units derived from posted journals.
 *
 * US (USD), 2024 activity only:
 *   Dr Cash 90.00 (9000), Dr Intercompany receivable 10.00 (1000), Cr Equity 100.00 (10000)
 *   Closing 0.90, historical 0.80 → Cash 8100, AR 900, Equity -8000, CTA -1000
 * UK (GBP):
 *   Dr Cash 50.00 (5000), Cr Intercompany payable 7.50 (750), Cr Equity 42.50 (4250)
 *   Closing 1.20, historical 1.10 → Cash 6000, AP -900, Equity -4675, CTA -425
 * Group EUR: CTA -1425. Elimination clears AR 900 against AP 900.
 * A 2023 US journal is posted and must stay outside the 2024 scope.
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
  let usCash = "";
  let usAr = "";
  let usEquity = "";
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
    const usPriorPeriod = await createPeriod(usEntityId, "2023-01-01", "2023-12-31");

    usCash = await createAccount(usEntityId, "1000", "Cash", "asset", "cash");
    usAr = await createAccount(usEntityId, "1200", "Intercompany receivable", "asset", "non_cash");
    usEquity = await createAccount(usEntityId, "3000", "Equity", "equity", "non_cash");
    ukCash = await createAccount(ukEntityId, "1000", "Cash", "asset", "cash");
    ukAp = await createAccount(ukEntityId, "2100", "Intercompany payable", "liability", "non_cash");
    ukEquity = await createAccount(ukEntityId, "3000", "Equity", "equity", "non_cash");

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
    await post(usEntityId, usPriorPeriod, "USD", [
      { accountId: usCash, debit: "1000000", credit: "0" },
      { accountId: usEquity, debit: "0", credit: "1000000" },
    ]);
  });

  it("pins the consolidated translation and elimination from posted entries", async () => {
    const translated = await translate(ledgerBody());
    expect(translated.status).toBe(200);
    const fx = await readJson<TranslationBody>(translated);
    expect(fx.engineVersion).toBe(ENGINE_VERSION);
    expect(fx.formulaVersion).toBe(FORMULA_VERSION);
    expect(fx.groupCurrency).toBe("EUR");
    expect(fx.ctaMinor).toBe("-1425");
    expect(lineMap(fx.lines)).toEqual(
      new Map([
        [usCash, "8100"],
        [usAr, "900"],
        [usEquity, "-8000"],
        [ukCash, "6000"],
        [ukAp, "-900"],
        [ukEquity, "-4675"],
        ["cta", "-1425"],
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
        [usCash, "8100"],
        [usAr, "0"],
        [usEquity, "-8000"],
        [ukCash, "6000"],
        [ukAp, "0"],
        [ukEquity, "-4675"],
        ["cta", "-1425"],
      ]),
    );
    expect(
      elimination.balances.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n),
    ).toBe(0n);
  });

  it("rejects a tampered caller-supplied balance without changing the posted result", async () => {
    const clean = await translate(ledgerBody());
    const pinned = await readJson<TranslationBody>(clean);
    expect(pinned.ctaMinor).toBe("-1425");

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
    expect(lineMap(elimination.balances).get(usCash)).toBe("8100");
    expect(lineMap(elimination.balances).get(usAr)).toBe("0");
    expect(
      elimination.balances.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n),
    ).toBe(0n);
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
  ) {
    const response = await call(app, "POST", "/v1/accounts", {
      actor: "owner-1",
      tenant: tenantId,
      region: "us-east-1",
      body: { entityId, code, name, report, cashFlow, retainedEarnings: false },
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
