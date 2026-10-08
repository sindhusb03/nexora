import { describe, expect, it } from "vitest";

import {
  buildTranslateRequest,
  decodeTranslation,
  displayRows,
  explainConsolidationError,
  formatMinorAccounting,
} from "./group-translate";

describe("group translation presentation", () => {
  it("formats integer minor units with parentheses for negatives", () => {
    expect(formatMinorAccounting("900", "EUR")).toBe("€9.00");
    expect(formatMinorAccounting("-10001225", "EUR")).toBe("(€100,012.25)");
    expect(formatMinorAccounting("0", "USD")).toBe("$0.00");
    expect(formatMinorAccounting(null, "USD")).toBe("—");
  });

  it("sends entities, periods, and rates without trial-balance lines or amounts", () => {
    const body = buildTranslateRequest({
      ctaAccountId: " cta ",
      reportingCurrency: "EUR",
      entities: [{ entityId: "us", periodId: "fy24", currency: "USD" }],
      rates: { USD: { closing: "0.90", historical: "0.80", average: "0.85" } },
    });
    expect(body.ctaAccountId).toBe("cta");
    expect(body.entities).toEqual([{ entityId: "us", periodId: "fy24" }]);
    expect(body.rates[0]?.closing).toMatchObject({
      base: "USD",
      quote: "EUR",
      rate: "0.90",
      rounding: "half_even",
    });
    expect(body).not.toHaveProperty("lines");
    expect(body).not.toHaveProperty("balances");
    expect(JSON.stringify(body)).not.toContain("debitPositiveMinor");
  });

  it("joins posted source lines to translated amounts and appends one CTA line", () => {
    const view = decodeTranslation({
      groupCurrency: "EUR",
      ctaAccountId: "cta",
      ctaMinor: "-100",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      calculationRunId: "run-1",
      engineVersion: "fe-kernel-0.2.1",
      formulaVersion: "current-rate-by-report-class-v1",
      controlTotalMinor: "0",
      lines: [
        { accountId: "cash", debitPositiveMinor: "900" },
        { accountId: "equity", debitPositiveMinor: "-800" },
        { accountId: "cta", debitPositiveMinor: "-100" },
      ],
      entities: [
        {
          entityId: "us",
          periodId: "fy24",
          sourceCurrency: "USD",
          ctaMinor: "-100",
          sourceLines: [
            { accountId: "cash", rateType: "closing", debitPositiveMinor: "1000" },
            { accountId: "equity", rateType: "historical", debitPositiveMinor: "-1000" },
          ],
          lines: [
            { accountId: "cash", debitPositiveMinor: "900" },
            { accountId: "cta", debitPositiveMinor: "-100" },
            { accountId: "equity", debitPositiveMinor: "-800" },
          ],
        },
      ],
    });
    expect(view).not.toBeNull();
    const rows = displayRows(view!, {
      entityName: () => "US Holdco",
      accountName: (accountId) => (accountId === "cash" ? "1000 Cash" : "3000 Equity"),
      rateFor: (_currency, rateType) => (rateType === "closing" ? "0.90" : "0.80"),
    });
    expect(rows.map((row) => row.accountLabel)).toEqual([
      "1000 Cash",
      "3000 Equity",
      "Cumulative translation adjustment",
    ]);
    expect(rows[0]).toMatchObject({
      sourceMinor: "1000",
      rateType: "closing",
      translatedMinor: "900",
      entityLabel: "US Holdco",
    });
    expect(rows[2]).toMatchObject({ cta: true, translatedMinor: "-100", sourceMinor: null });
    expect(view?.controlTotalMinor).toBe("0");
  });

  it("leaves a translated amount empty when the kernel omits that account", () => {
    const view = decodeTranslation({
      groupCurrency: "EUR",
      ctaAccountId: "cta",
      ctaMinor: "0",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      calculationRunId: "run-1",
      controlTotalMinor: "0",
      lines: [{ accountId: "cta", debitPositiveMinor: "0" }],
      entities: [
        {
          entityId: "us",
          periodId: "fy24",
          sourceCurrency: "USD",
          ctaMinor: "0",
          sourceLines: [{ accountId: "cash", rateType: "closing", debitPositiveMinor: "0" }],
          lines: [{ accountId: "cta", debitPositiveMinor: "0" }],
        },
      ],
    });
    expect(view).not.toBeNull();
    const rows = displayRows(view!, {
      entityName: () => "US Holdco",
      accountName: () => "1000 Cash",
      rateFor: () => null,
    });
    expect(rows[0]?.translatedMinor).toBeNull();
    expect(formatMinorAccounting(rows[0]?.translatedMinor ?? null, "EUR")).toBe("—");
  });

  it("explains missing rates, mismatched periods, and an identity rate other than 1", () => {
    expect(explainConsolidationError(400, "FX_RATE_MISSING", "No FX rates for GBP").title).toBe(
      "A rate is missing",
    );
    expect(
      explainConsolidationError(
        422,
        "FIN_INVALID_PERIOD",
        "Consolidation periods must share the same start and end dates",
      ).title,
    ).toBe("The periods do not match");
    expect(
      explainConsolidationError(
        400,
        "FX_INVALID_RATE",
        "An identity translation requires a rate of exactly 1",
      ).title,
    ).toBe("Identity rate must be 1");
  });
});
