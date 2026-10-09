import { KernelError, type KernelErrorCode } from "@nexora/kernel";
import type { EntityRecord, LedgerStore, PeriodRecord, PostedActivityLine } from "@nexora/db";
import { describe, expect, it } from "vitest";

import { statusFor } from "../src/http.js";
import { loadPostedTrialBalance } from "../src/program-service.js";

const tenantId = "tenant-currency";
const entityId = "entity-usd";
const periodId = "period-2024";

describe("loadPostedTrialBalance currency guard", () => {
  it("rejects a posted line in a non-functional currency", async () => {
    const error = await loadPostedTrialBalance(
      storeWithPostedCurrency("EUR"),
      tenantId,
      entityId,
      periodId,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KernelError);
    if (!(error instanceof KernelError)) {
      throw error;
    }
    const code: KernelErrorCode = error.code;
    expect(code).toBe("FIN_CURRENCY_MISMATCH");
    expect(statusFor(code)).toBe(400);
  });
});

function storeWithPostedCurrency(currency: string): LedgerStore {
  const entity: EntityRecord = {
    entityId,
    tenantId,
    legalName: "USD books",
    functionalCurrency: "USD",
    fiscalYearEndMonth: 12,
    fiscalYearEndDay: 31,
    retainedEarningsAccountId: "retained-earnings",
  };
  const period: PeriodRecord = {
    periodId,
    tenantId,
    entityId,
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    status: "open",
  };
  const line: PostedActivityLine = {
    journalId: "journal-eur",
    accountId: "cash",
    report: "asset",
    cashFlow: "cash",
    currency,
    debitMinor: "1000",
    creditMinor: "0",
    periodId,
    periodStart: "2024-01-01",
    periodEnd: "2024-12-31",
  };
  return {
    getEntity: async () => entity,
    getPeriod: async () => period,
    listPostedActivity: async () => [line],
  } as unknown as LedgerStore;
}
