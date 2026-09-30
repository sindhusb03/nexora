import { describe, expect, it } from "vitest";

import { buildStatements, type ClassifiedLine } from "../src/index.js";

const USD = "USD";

function movement(
  accountId: string,
  report: ClassifiedLine["report"],
  cashFlow: ClassifiedLine["cashFlow"],
  debit: string,
  credit: string,
  period: ClassifiedLine["period"],
): ClassifiedLine {
  return {
    accountId,
    report,
    cashFlow,
    debitMinor: debit,
    creditMinor: credit,
    currency: USD,
    period,
  };
}

describe("single entity statements", () => {
  it("reconciles income, balance sheet, cash, and retained earnings", () => {
    const statement = buildStatements({
      currency: USD,
      retainedEarningsAccountId: "re",
      lines: [
        movement("cash", "asset", "cash", "100000", "0", "opening"),
        movement("re", "equity", "non_cash", "0", "100000", "opening"),
        movement("cash", "asset", "cash", "80000", "0", "movement"),
        movement("revenue", "revenue", "cfo", "0", "80000", "movement"),
        movement("expense", "expense", "cfo", "30000", "0", "movement"),
        movement("cash", "asset", "cash", "0", "30000", "movement"),
        movement("ppe", "asset", "cfi", "20000", "0", "movement"),
        movement("cash", "asset", "cash", "0", "20000", "movement"),
        movement("cash", "asset", "cash", "15000", "0", "movement"),
        movement("debt", "liability", "cff", "0", "15000", "movement"),
        movement("dividends", "equity", "distribution", "5000", "0", "movement"),
        movement("cash", "asset", "cash", "0", "5000", "movement"),
      ],
    });

    expect(statement.incomeStatement).toEqual({
      revenueMinor: "80000",
      expensesMinor: "30000",
      netIncomeMinor: "50000",
    });
    expect(statement.balanceSheet).toEqual({
      assetsMinor: "160000",
      liabilitiesMinor: "15000",
      equityMinor: "145000",
    });
    expect(statement.cashFlow).toEqual({
      beginningCashMinor: "100000",
      cfoMinor: "50000",
      cfiMinor: "-20000",
      cffMinor: "10000",
      endingCashMinor: "140000",
    });
    expect(statement.retainedEarnings).toEqual({
      openingMinor: "100000",
      netIncomeMinor: "50000",
      distributionsMinor: "5000",
      endingMinor: "145000",
      close: "derived",
    });
    expect(statement.inputHash).toHaveLength(64);
  });

  it("fails closed when the books do not balance", () => {
    expect(() =>
      buildStatements({
        currency: USD,
        retainedEarningsAccountId: "re",
        lines: [
          movement("cash", "asset", "cash", "100", "0", "movement"),
          movement("revenue", "revenue", "cfo", "0", "90", "movement"),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_STATEMENT_IMBALANCE" }));
  });
});
