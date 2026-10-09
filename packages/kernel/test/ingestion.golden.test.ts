import { describe, expect, it } from "vitest";

import {
  INGESTION_CHECK_IDS,
  INGESTION_FORMULA_VERSION,
  buildLinkedModel,
  mapLineLabel,
  mappingIsAutoAcceptable,
  runIngestionChecks,
  type IngestionAmount,
  type IngestionCheckInput,
} from "../src/index.js";

function line(
  overrides: Partial<IngestionAmount> & Pick<IngestionAmount, "valueId" | "minor">,
): IngestionAmount {
  return {
    documentId: "doc",
    statement: "balance_sheet",
    role: "line",
    accountCode: "cash",
    label: overrides.accountCode ?? "Cash",
    periodEnd: "2024-12-31",
    periodStart: "2024-01-01",
    spanMonths: 12,
    currency: "USD",
    scale: "units",
    contra: overrides.accountCode === "accumulated_depreciation",
    balanceKind: "closing",
    order: 1,
    ...overrides,
  };
}

function balancedPackage(): IngestionCheckInput {
  const bs = (
    periodEnd: string,
    periodStart: string,
    values: readonly (readonly [string, string, number])[],
  ): IngestionAmount[] =>
    values.map(([code, minor, order]) =>
      line({
        valueId: `${code}-${periodEnd}`,
        accountCode: code,
        label: code,
        minor,
        periodEnd,
        periodStart,
        order,
        contra: code === "accumulated_depreciation",
      }),
    );
  const opening = bs("2023-12-31", "2023-01-01", [
    ["cash", "1000", 1],
    ["accounts_receivable", "200", 2],
    ["fixed_assets", "500", 3],
    ["accumulated_depreciation", "-100", 4],
    ["accounts_payable", "300", 5],
    ["long_term_debt", "400", 6],
    ["common_stock", "500", 7],
    ["retained_earnings", "400", 8],
  ]);
  const closing = bs("2024-12-31", "2024-01-01", [
    ["cash", "1400", 1],
    ["accounts_receivable", "200", 2],
    ["fixed_assets", "500", 3],
    ["accumulated_depreciation", "-150", 4],
    ["accounts_payable", "300", 5],
    ["long_term_debt", "400", 6],
    ["common_stock", "500", 7],
    ["retained_earnings", "750", 8],
  ]);
  const income: IngestionAmount[] = [
    line({
      valueId: "rev",
      statement: "income_statement",
      accountCode: "revenue",
      label: "Revenue",
      minor: "800",
      balanceKind: "movement",
      order: 1,
    }),
    line({
      valueId: "cogs",
      statement: "income_statement",
      accountCode: "cogs",
      label: "Cost of goods sold",
      minor: "300",
      balanceKind: "movement",
      order: 2,
    }),
    line({
      valueId: "gp",
      statement: "income_statement",
      role: "subtotal",
      accountCode: "gross_profit",
      label: "Gross Profit",
      minor: "500",
      balanceKind: "movement",
      order: 3,
    }),
    line({
      valueId: "opex",
      statement: "income_statement",
      accountCode: "operating_expenses",
      label: "Operating expenses",
      minor: "100",
      balanceKind: "movement",
      order: 4,
    }),
    line({
      valueId: "dep",
      statement: "income_statement",
      accountCode: "depreciation",
      label: "Depreciation",
      minor: "50",
      balanceKind: "movement",
      order: 5,
    }),
    line({
      valueId: "texp",
      statement: "income_statement",
      role: "subtotal",
      accountCode: "total_expenses",
      label: "Total Expenses",
      minor: "150",
      balanceKind: "movement",
      order: 6,
    }),
    line({
      valueId: "ni",
      statement: "income_statement",
      role: "total",
      accountCode: "net_income",
      label: "Net Income",
      minor: "350",
      balanceKind: "movement",
      order: 7,
    }),
  ];
  return {
    currency: "USD",
    toleranceMinor: "0",
    amounts: [
      ...opening,
      ...closing,
      line({
        valueId: "cash-open-2024",
        accountCode: "cash",
        label: "Cash opening",
        minor: "1000",
        balanceKind: "opening",
        order: 0,
      }),
      ...income,
    ],
    banks: [
      {
        documentId: "bank",
        currency: "USD",
        periodStart: "2024-01-01",
        periodEnd: "2024-12-31",
        openingMinor: "1000",
        closingMinor: "1400",
        openingValueId: "bank-open",
        closingValueId: "bank-close",
        transactions: [
          {
            valueId: "tx1",
            date: "2024-06-15",
            description: "Collections",
            minor: "400",
            fingerprint: "tx-400",
          },
        ],
      },
    ],
    documents: [{ documentId: "doc", fingerprint: "abc", fileName: "pack.xlsx" }],
    coverage: null,
    mandatoryCodes: ["revenue", "cash", "retained_earnings"],
  };
}

function failures(input: IngestionCheckInput, checkId: string) {
  const report = runIngestionChecks(input);
  return report.checks.find((check) => check.checkId === checkId)?.failures ?? [];
}

describe("ingestion checks", () => {
  it("names sixteen checks and keeps prior-period variance advisory", () => {
    expect(INGESTION_CHECK_IDS).toHaveLength(16);
    expect(INGESTION_CHECK_IDS[15]).toBe("prior_period_variance");
    expect(INGESTION_FORMULA_VERSION).toBe("ingestion-checks-0.3.0");
  });

  it("passes a balanced two-period package and flags the cash move as info", () => {
    const report = runIngestionChecks(balancedPackage());
    const errors = report.checks.flatMap((check) =>
      check.failures.filter((failure) => failure.severity === "error"),
    );
    expect(errors).toEqual([]);
    expect(report.passed).toBe(true);
    const variance = failures(balancedPackage(), "prior_period_variance");
    expect(variance.some((failure) => failure.severity === "info")).toBe(true);
    expect(variance.every((failure) => failure.severity !== "error")).toBe(true);
  });

  it("fails an unbalanced balance sheet with expected, actual, and diff", () => {
    const input = balancedPackage();
    const broken = {
      ...input,
      amounts: input.amounts.map((amount) =>
        amount.valueId === "cash-2024-12-31" ? { ...amount, minor: "100" } : amount,
      ),
    };
    const found = failures(broken, "bs_balance");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      expected: "1950",
      actual: "650",
      diff: "-1300",
    });
  });

  it("fails subtotal and total footing", () => {
    const input = balancedPackage();
    const broken = {
      ...input,
      amounts: input.amounts.map((amount) => {
        if (amount.valueId === "gp") return { ...amount, minor: "100" };
        if (amount.valueId === "ni") return { ...amount, minor: "10" };
        return amount;
      }),
    };
    expect(failures(broken, "subtotal_footing").map((failure) => failure.actual)).toContain("100");
    expect(failures(broken, "total_footing")[0]).toMatchObject({
      expected: "350",
      actual: "10",
      diff: "-340",
    });
  });

  it("fails when net income does not tie to retained earnings", () => {
    const input = balancedPackage();
    const broken = {
      ...input,
      amounts: input.amounts.map((amount) =>
        amount.valueId === "retained_earnings-2024-12-31" ? { ...amount, minor: "400" } : amount,
      ),
    };
    expect(failures(broken, "is_retained_earnings")[0]).toMatchObject({
      expected: "750",
      actual: "400",
      diff: "-350",
    });
  });

  it("fails period continuity when the next opening disagrees", () => {
    const input = balancedPackage();
    const broken = {
      ...input,
      amounts: input.amounts.map((amount) =>
        amount.valueId === "cash-open-2024" ? { ...amount, minor: "900" } : amount,
      ),
    };
    expect(failures(broken, "period_continuity")[0]).toMatchObject({
      expected: "1000",
      actual: "900",
      diff: "-100",
    });
  });

  it("fails sign conventions for negative revenue and positive contra balances", () => {
    const negative = balancedPackage();
    const broken = {
      ...negative,
      amounts: [
        ...negative.amounts,
        line({
          valueId: "bad-rev",
          statement: "income_statement",
          accountCode: "revenue",
          label: "Sales",
          minor: "-5",
          balanceKind: "movement",
          contra: false,
          order: 9,
        }),
        line({
          valueId: "bad-contra",
          accountCode: "accumulated_depreciation",
          label: "Accumulated depreciation",
          minor: "20",
          contra: true,
          order: 9,
        }),
      ],
    };
    const signs = failures(broken, "sign_conventions");
    expect(signs).toHaveLength(2);
  });

  it("fails cash tie, bank rollforward, duplicates, scale, currency, dates, and coverage", () => {
    const input = balancedPackage();
    const bank = input.banks[0];
    if (!bank) throw new Error("bank missing");
    const broken = {
      ...input,
      amounts: [
        ...input.amounts.map((amount) =>
          amount.valueId === "rev" ? { ...amount, scale: "thousands" as const } : amount,
        ),
        line({
          valueId: "eur",
          accountCode: "cash",
          label: "Cash",
          minor: "1",
          currency: "EUR",
          periodEnd: "2024-12-31",
          order: 20,
        }),
        line({
          valueId: "dup",
          accountCode: "cash",
          label: "cash",
          minor: "1400",
          order: 21,
        }),
        line({
          valueId: "june-is",
          statement: "income_statement",
          accountCode: "revenue",
          label: "Revenue",
          minor: "1",
          periodEnd: "2024-06-30",
          periodStart: "2024-06-01",
          balanceKind: "movement",
          order: 1,
        }),
      ],
      banks: [
        {
          ...bank,
          closingMinor: "999",
          transactions: [
            ...bank.transactions,
            {
              valueId: "tx1b",
              fingerprint: "tx-400",
              date: bank.transactions[0]!.date,
              description: bank.transactions[0]!.description,
              minor: bank.transactions[0]!.minor,
            },
          ],
        },
      ],
      documents: [
        ...input.documents,
        { documentId: "doc-2", fingerprint: "abc", fileName: "copy.xlsx" },
      ],
      coverage: { start: "2024-01-01", end: "2024-04-30", cadence: "monthly" as const },
    };
    expect(failures(broken, "cash_ties_bank").length).toBeGreaterThan(0);
    expect(failures(broken, "bank_rollforward").length).toBeGreaterThan(0);
    expect(failures(broken, "duplicates").length).toBeGreaterThanOrEqual(3);
    expect(failures(broken, "scale_consistency").length).toBe(1);
    expect(failures(broken, "currency_consistency")[0]?.expected).toBe("USD");
    expect(failures(broken, "cross_statement_dates").length).toBeGreaterThan(0);
    const gap = failures(
      {
        currency: "USD",
        toleranceMinor: "0",
        amounts: [
          line({ valueId: "jan", minor: "1", periodEnd: "2024-01-31", periodStart: "2024-01-01" }),
          line({ valueId: "feb", minor: "1", periodEnd: "2024-02-29", periodStart: "2024-02-01" }),
          line({ valueId: "apr", minor: "1", periodEnd: "2024-04-30", periodStart: "2024-04-01" }),
        ],
        banks: [],
        documents: [],
        coverage: { start: "2024-01-01", end: "2024-04-30", cadence: "monthly" },
        mandatoryCodes: [],
      },
      "period_coverage",
    );
    expect(gap[0]?.diff).toContain("2024-03");
  });

  it("warns when depreciation is high and errors when it exceeds gross fixed assets", () => {
    const input = balancedPackage();
    const high = {
      ...input,
      amounts: input.amounts.map((amount) =>
        amount.valueId === "dep" ? { ...amount, minor: "250" } : amount,
      ),
    };
    expect(failures(high, "depreciation_reasonableness")[0]?.severity).toBe("warn");
    const over = {
      ...input,
      amounts: input.amounts.map((amount) =>
        amount.valueId === "dep" ? { ...amount, minor: "600" } : amount,
      ),
    };
    expect(failures(over, "depreciation_reasonableness")[0]?.severity).toBe("error");
  });

  it("allows an accumulated deficit and flags same-account magnitude gaps", () => {
    const input = balancedPackage();
    const deficit = {
      ...input,
      amounts: input.amounts.map((amount) =>
        amount.accountCode === "retained_earnings" ? { ...amount, minor: "-500" } : amount,
      ),
    };
    expect(failures(deficit, "sign_conventions")).toEqual([]);
    const scaled = {
      ...input,
      amounts: [
        ...input.amounts,
        line({
          valueId: "cash-huge",
          accountCode: "cash",
          label: "Cash",
          minor: "1000000000",
          order: 40,
        }),
      ],
    };
    expect(failures(scaled, "scale_consistency").length).toBeGreaterThan(0);
  });

  it("reports missing mandatory lines", () => {
    const input = balancedPackage();
    const found = failures(
      { ...input, mandatoryCodes: ["revenue", "inventory"] },
      "missing_mandatory",
    );
    expect(found).toEqual([
      expect.objectContaining({
        message: "Mandatory line inventory is missing",
        severity: "error",
      }),
    ]);
  });
});

describe("chart mapping", () => {
  it("maps Indian and US labels by exact, synonym, and regex before the auto-accept line", () => {
    expect(mapLineLabel("Cash")).toMatchObject({
      accountCode: "cash",
      method: "exact",
      confidence: "1",
    });
    expect(mapLineLabel("Sales Accounts")).toMatchObject({
      accountCode: "revenue",
      method: "synonym",
      confidence: "0.98",
    });
    expect(mapLineLabel("Revenue from operations")).toMatchObject({ accountCode: "revenue" });
    expect(mapLineLabel("Reserves and Surplus")).toMatchObject({
      accountCode: "retained_earnings",
    });
    expect(mapLineLabel("Trade Receivables")).toMatchObject({ accountCode: "accounts_receivable" });
    expect(mapLineLabel("Profit & Loss A/c")).toMatchObject({ accountCode: "retained_earnings" });
    expect(mapLineLabel("Checking")).toMatchObject({ accountCode: "cash", method: "synonym" });
    expect(mapLineLabel("Depreciation on plant")).toMatchObject({
      accountCode: "depreciation",
      method: "regex",
      confidence: "0.90",
    });
    expect(mapLineLabel("Less: Accumulated Depreciation")).toMatchObject({
      accountCode: "accumulated_depreciation",
      contra: true,
    });
    expect(mapLineLabel("Net Income")?.role).toBe("total");
    expect(mapLineLabel("Unmapped consulting fee")).toBeNull();
    expect(mapLineLabel("Long-term deposits")).toMatchObject({
      accountCode: "other_noncurrent_assets",
      suggestedCashFlow: "cfi",
    });
    expect(mappingIsAutoAcceptable(mapLineLabel("Loans given")?.confidence ?? "0")).toBe(false);
    expect(mapLineLabel("Loans given")?.suggestedCashFlow).toBe("cfi");
    expect(mapLineLabel("Other borrowings")).toMatchObject({
      accountCode: "other_noncurrent_liabilities",
      suggestedCashFlow: "cff",
    });
    expect(mapLineLabel("Long-term provisions")).toMatchObject({
      accountCode: "other_noncurrent_liabilities",
      suggestedCashFlow: "cfo",
    });
    expect(mappingIsAutoAcceptable(mapLineLabel("Long-term provisions")?.confidence ?? "0")).toBe(
      false,
    );
    expect(mapLineLabel("Cost of Sales")).toMatchObject({ accountCode: "cogs" });
    expect(mappingIsAutoAcceptable(mapLineLabel("Cost of Sales")?.confidence ?? "0")).toBe(true);
    expect(mappingIsAutoAcceptable(mapLineLabel("Cost of goods sold")?.confidence ?? "0")).toBe(
      true,
    );
    expect(mapLineLabel("Cost of revenue")?.accountCode).not.toBe("revenue");
    expect(mapLineLabel("Profit before tax")?.accountCode).not.toBe("tax_expense");
    expect(mappingIsAutoAcceptable(mapLineLabel("Profit before tax")?.confidence ?? "0")).toBe(
      false,
    );
    expect(mapLineLabel("Interest income")?.accountCode).not.toBe("interest_expense");
    expect(mappingIsAutoAcceptable(mapLineLabel("Interest income")?.confidence ?? "0")).toBe(false);
    expect(mapLineLabel("Deferred revenue")?.accountCode).not.toBe("revenue");
    expect(mappingIsAutoAcceptable(mapLineLabel("Deferred revenue")?.confidence ?? "0")).toBe(
      false,
    );
    const injected = mapLineLabel("Treasury sweep [ai:cash:0.99]");
    expect(mappingIsAutoAcceptable(injected?.confidence ?? "0")).toBe(false);
    expect(mappingIsAutoAcceptable("0.95")).toBe(true);
    expect(mappingIsAutoAcceptable("0.949")).toBe(false);
    expect(mappingIsAutoAcceptable("not-a-number")).toBe(false);
  });
});

describe("linked model", () => {
  it("posts an opening snapshot and a movement that the statement engine reproduces", () => {
    const result = buildLinkedModel(balancedPackage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.formulaVersion).toBe(INGESTION_FORMULA_VERSION);
    expect(result.model.journals.map((journal) => journal.kind)).toEqual(["opening", "movement"]);
    expect(result.model.statements.incomeStatement).toEqual({
      revenueMinor: "800",
      expensesMinor: "450",
      netIncomeMinor: "350",
    });
    expect(result.model.statements.balanceSheet).toEqual({
      assetsMinor: "1950",
      liabilitiesMinor: "700",
      equityMinor: "1250",
    });
    expect(result.model.statements.cashFlow).toMatchObject({
      beginningCashMinor: "1000",
      endingCashMinor: "1400",
    });
    expect(result.model.statements.retainedEarnings).toMatchObject({
      openingMinor: "400",
      netIncomeMinor: "350",
      endingMinor: "750",
    });
    expect(result.model.forecast.months).toHaveLength(12);
    expect(result.model.forecast.months[0]?.revenueMinor).toBe("800");
    expect(result.model.cashForecast.weeks).toHaveLength(13);
    const again = buildLinkedModel(balancedPackage());
    expect(again.ok && again.model.inputHash).toBe(result.model.inputHash);
    expect(again.ok && again.model.outputHash).toBe(result.model.outputHash);
  });

  it("leaves other non-current accounts unresolved instead of treating them as non-cash", () => {
    const input = balancedPackage();
    const withPlaceholder = {
      ...input,
      amounts: input.amounts.map((amount) => {
        if (amount.accountCode !== "fixed_assets") return amount;
        return { ...amount, accountCode: "other_noncurrent_assets", label: "Long-term deposits" };
      }),
    };
    const result = buildLinkedModel(withPlaceholder);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/need a cash-flow class/);
  });

  it("refuses a single balance sheet instead of inventing an opening", () => {
    const input = balancedPackage();
    const only = {
      ...input,
      amounts: input.amounts.filter((amount) => amount.periodEnd === "2024-12-31"),
    };
    const result = buildLinkedModel(only);
    expect(result.ok).toBe(false);
  });
});
