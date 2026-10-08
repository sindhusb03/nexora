import { describe, expect, it } from "vitest";

import { KernelError, buildStatements, hashMaterial, type ClassifiedLine } from "../src/index.js";

function line(
  accountId: string,
  report: ClassifiedLine["report"],
  cashFlow: ClassifiedLine["cashFlow"],
  debit: number | string,
  credit: number | string,
  journalId?: string,
  period: ClassifiedLine["period"] = "movement",
) {
  return {
    accountId,
    report,
    cashFlow,
    debitMinor: String(debit),
    creditMinor: String(credit),
    currency: "USD",
    period,
    ...(journalId === undefined ? {} : { journalId }),
  };
}

const opening = [
  line("cash", "asset", "cash", 100, 0, undefined, "opening"),
  line("re", "equity", "non_cash", 0, 100, undefined, "opening"),
];
const statements = (lines: readonly ClassifiedLine[]) =>
  buildStatements({ currency: "USD", retainedEarningsAccountId: "re", lines });

describe("journal cash flow and retained earnings golden vectors (fe-kernel-0.3.0)", () => {
  it("records the formula version", () => {
    expect(statements(opening).engineVersion).toBe("fe-kernel-0.3.0");
  });

  it("rejects journal cash movement without a matching counterpart with a kernel error", () => {
    const build = () =>
      statements([
        line("cash", "asset", "cash", 10, 0, "one-sided"),
        line("receivable", "asset", "cfo", 10, 0, "one-sided"),
      ]);
    expect(build).toThrow(KernelError);
    expect(build).toThrow(
      expect.objectContaining({
        code: "FIN_STATEMENT_IMBALANCE",
        message: "Journal one-sided cash movement has no counterpart",
      }),
    );
  });

  it("excludes equipment financed entirely by a loan from CFI and CFF", () => {
    const result = statements([
      line("equipment", "asset", "cfi", 100, 0, "loan"),
      line("debt", "liability", "cff", 0, 100, "loan"),
    ]);
    expect(result.cashFlow).toEqual({
      beginningCashMinor: "0",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "0",
    });
  });

  it("classifies each counter of a part-cash equipment purchase", () => {
    const result = statements([
      ...opening,
      line("equipment", "asset", "cfi", 100, 0, "purchase"),
      line("cash", "asset", "cash", 0, 30, "purchase"),
      line("debt", "liability", "cff", 0, 70, "purchase"),
    ]);
    expect(result.cashFlow).toEqual({
      beginningCashMinor: "100",
      cfoMinor: "0",
      cfiMinor: "-100",
      cffMinor: "70",
      endingCashMinor: "70",
    });
  });

  it("nets a mixed CFO journal and ignores noncash accruals", () => {
    const result = statements([
      line("cash", "asset", "cash", 70, 0, "sale"),
      line("fees", "expense", "cfo", 30, 0, "sale"),
      line("revenue", "revenue", "cfo", 0, 100, "sale"),
      line("receivable", "asset", "cfo", 50, 0, "accrual"),
      line("revenue", "revenue", "cfo", 0, 50, "accrual"),
    ]);
    expect(result.cashFlow.cfoMinor).toBe("70");
    expect(result.incomeStatement.netIncomeMinor).toBe("120");
  });

  it("classifies one cash leg and three counters exactly, independent of input order", () => {
    const lines = [
      ...opening,
      line("cash", "asset", "cash", 0, 5, "mixed"),
      line("a-expense", "expense", "cfo", 4, 0, "mixed"),
      line("z-equipment", "asset", "cfi", 4, 0, "mixed"),
      line("debt", "liability", "cff", 0, 3, "mixed"),
    ];
    expect(statements(lines).cashFlow).toEqual({
      beginningCashMinor: "100",
      cfoMinor: "-4",
      cfiMinor: "-4",
      cffMinor: "3",
      endingCashMinor: "95",
    });
    expect(statements([...lines].reverse()).cashFlow).toEqual(statements(lines).cashFlow);
  });

  it("preserves legacy numbers and hash material without journal IDs (including partial IDs)", () => {
    const lines = [
      ...opening,
      line("equipment", "asset", "cfi", 100, 0),
      line("cash", "asset", "cash", 0, 30),
      line("debt", "liability", "cff", 0, 70),
    ];
    const result = statements(lines);
    expect(result.cashFlow).toEqual({
      beginningCashMinor: "100",
      cfoMinor: "0",
      cfiMinor: "-100",
      cffMinor: "70",
      endingCashMinor: "70",
    });
    expect(result.inputHash).toBe(
      hashMaterial({ currency: "USD", retainedEarningsAccountId: "re", lines }),
    );
    expect(
      statements(lines.map((entry, i) => (i === 2 ? { ...entry, journalId: "partial" } : entry)))
        .cashFlow,
    ).toEqual(result.cashFlow);
    expect(statements(lines.map((entry) => ({ ...entry, journalId: "all" }))).inputHash).not.toBe(
      result.inputHash,
    );
  });

  it("allocates amounts above Number.MAX_SAFE_INTEGER without losing minor units", () => {
    const result = statements([
      line("cash", "asset", "cash", "9007199254740993", 0, "large"),
      line("receivable", "asset", "cfo", "9007199254740993", 0, "large"),
      line("a-revenue", "revenue", "cfo", 0, "9007199254740993", "large"),
      line("z-debt", "liability", "cff", 0, "9007199254740993", "large"),
    ]);
    expect(result.cashFlow).toEqual({
      beginningCashMinor: "0",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "9007199254740993",
      endingCashMinor: "9007199254740993",
    });
  });

  it("folds prior distributions into opening RE without changing ending RE or equity", () => {
    const result = statements([
      ...opening,
      line("distribution", "equity", "distribution", 20, 0, "prior", "opening"),
      line("cash", "asset", "cash", 0, 20, "prior", "opening"),
      line("distribution", "equity", "distribution", 5, 0, "current"),
      line("cash", "asset", "cash", 0, 5, "current"),
    ]);
    expect(result.retainedEarnings).toEqual({
      openingMinor: "80",
      netIncomeMinor: "0",
      distributionsMinor: "5",
      directEntriesMinor: "0",
      endingMinor: "75",
      close: "derived",
    });
    expect(result.balanceSheet.equityMinor).toBe("75");
    expect(result.cashFlow.cffMinor).toBe("-5");
  });

  it("still rejects cash movement allocated to non_cash", () => {
    expect(() =>
      statements([
        line("cash", "asset", "cash", 10, 0, "unclassified"),
        line("capital", "equity", "non_cash", 0, 10, "unclassified"),
      ]),
    ).toThrow("Cash classification needed");
  });
});
