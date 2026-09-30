import { describe, expect, it } from "vitest";

import {
  KernelError,
  assertCurrency,
  assertExpectedVersion,
  assertNoPeriodOverlap,
  assertPeriodRange,
  assertTenantActive,
  buildReversalLines,
  buildStatements,
  compareMoney,
  evaluateGraph,
  formatMinor,
  hashMaterial,
  isKernelError,
  isZeroMoney,
  money,
  moneyFromDecimal,
  negateMoney,
  netLinesToZero,
  stateHash,
  validateJournal,
  zeroMoney,
  type CalcNode,
  type ClassifiedLine,
} from "../src/index.js";
import { assertNonNegativeMinor, isNegativeMinor } from "../src/money.js";

function line(accountId: string, debit: bigint, credit: bigint) {
  return {
    accountId,
    debit: money("USD", debit),
    credit: money("USD", credit),
  };
}

function movement(
  accountId: string,
  report: ClassifiedLine["report"],
  cashFlow: ClassifiedLine["cashFlow"],
  debit: string,
  credit: string,
  period: ClassifiedLine["period"],
  currency = "USD",
): ClassifiedLine {
  return {
    accountId,
    report,
    cashFlow,
    debitMinor: debit,
    creditMinor: credit,
    currency,
    period,
  };
}

describe("rejection paths that guard the ledger", () => {
  it("rejects malformed money before it can enter a journal", () => {
    expect(() => assertCurrency("usd")).toThrowError(
      expect.objectContaining({ code: "FIN_CURRENCY_MISMATCH" }),
    );
    expect(() => money("USD", "1.5")).toThrowError(
      expect.objectContaining({ code: "FIN_AMOUNT_SCALE" }),
    );
    expect(() => moneyFromDecimal("USD", "10.25USD")).toThrow(KernelError);
    expect(compareMoney(money("USD", 10n), money("USD", 10n))).toBe(0);
    expect(compareMoney(money("USD", 1n), money("USD", 2n))).toBe(-1);
    expect(isZeroMoney(zeroMoney("USD"))).toBe(true);
    expect(isZeroMoney(money("USD", 1n))).toBe(false);
    expect(isNegativeMinor("-4")).toBe(true);
    expect(negateMoney(money("JPY", 5n))).toEqual({ currency: "JPY", minor: "-5", scale: 0 });
    expect(formatMinor("1500", 0)).toBe("1500");
    expect(formatMinor("-1500", 0)).toBe("-1500");
    expect(() => assertNonNegativeMinor("-1", "Debit")).toThrowError(
      expect.objectContaining({ code: "FIN_INVALID_JOURNAL_LINE" }),
    );
  });

  it("rejects a negative debit inside an otherwise balanced journal", () => {
    expect(() =>
      validateJournal({
        currency: "USD",
        entityId: "entity-1",
        periodId: "period-1",
        lines: [line("cash", -100n, 0n), line("revenue", 0n, -100n)],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_INVALID_JOURNAL_LINE" }));
    expect(() =>
      validateJournal({
        currency: "USD",
        entityId: "",
        periodId: "period-1",
        lines: [line("cash", 1n, 0n), line("revenue", 0n, 1n)],
      }),
    ).toThrow(KernelError);
    expect(() => buildReversalLines([])).toThrow(KernelError);
    const posted = [
      {
        accountId: "cash",
        debitMinor: "10",
        creditMinor: "0",
        currency: "USD",
      },
    ];
    expect(
      netLinesToZero(posted, [
        { accountId: "cash", debitMinor: "0", creditMinor: "9", currency: "USD" },
      ]),
    ).toBe(false);
  });

  it("rejects period, version, and tenant mistakes", () => {
    expect(() => assertPeriodRange("2026-13-01", "2026-01-01")).toThrowError(
      expect.objectContaining({ code: "FIN_INVALID_PERIOD" }),
    );
    expect(() =>
      assertNoPeriodOverlap({ startDate: "2026-02-01", endDate: "2026-02-28" }, [
        { startDate: "2026-02-15", endDate: "2026-03-15" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "FIN_OVERLAPPING_PERIOD" }));
    expect(() => assertExpectedVersion(3, 2)).toThrowError(
      expect.objectContaining({ code: "FIN_VERSION_CONFLICT" }),
    );
    expect(() => assertExpectedVersion(3, undefined)).not.toThrow();
    expect(() => assertTenantActive("suspended")).toThrowError(
      expect.objectContaining({ code: "TENANT_SUSPENDED" }),
    );
    expect(isKernelError(new KernelError("FIN_NOT_FOUND", "missing"))).toBe(true);
    expect(isKernelError(new Error("missing"))).toBe(false);
  });

  it("rejects hashes that are not plain data", () => {
    expect(() => hashMaterial(1n)).toThrow(KernelError);
    expect(() => hashMaterial(undefined)).toThrow(KernelError);
    expect(() => hashMaterial({ keep: "1", drop: undefined })).not.toThrow();
    expect(() => stateHash({ entityId: "e1" }, [])).toThrow(KernelError);
    expect(() => stateHash({ entityId: "e1" }, ["periodId"])).toThrow(KernelError);
  });

  it("rejects statement lines that cannot close", () => {
    expect(() =>
      buildStatements({
        currency: "USD",
        retainedEarningsAccountId: "",
        lines: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_STATEMENT_IMBALANCE" }));

    expect(() =>
      buildStatements({
        currency: "USD",
        retainedEarningsAccountId: "re",
        lines: [movement("cash", "asset", "cash", "100", "0", "opening", "EUR")],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_CURRENCY_MISMATCH" }));

    expect(() =>
      buildStatements({
        currency: "USD",
        retainedEarningsAccountId: "re",
        lines: [movement("cash", "asset", "cash", "-1", "0", "movement")],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_INVALID_JOURNAL_LINE" }));

    expect(() =>
      buildStatements({
        currency: "USD",
        retainedEarningsAccountId: "re",
        lines: [
          movement("cash", "asset", "cash", "100", "0", "opening"),
          movement("cash", "liability", "cfo", "0", "100", "opening"),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "FIN_STATEMENT_IMBALANCE" }));

    expect(() =>
      buildStatements({
        currency: "USD",
        retainedEarningsAccountId: "re",
        lines: [
          movement("cash", "asset", "cash", "50", "0", "opening"),
          movement("re", "equity", "distribution", "0", "50", "opening"),
        ],
      }),
    ).toThrow(KernelError);
  });

  it("rejects calculation graphs that are empty, duplicated, or not decimal", () => {
    expect(() => evaluateGraph([])).toThrowError(
      expect.objectContaining({ code: "CALC_INVALID_NODE" }),
    );
    expect(() =>
      evaluateGraph([
        { id: "a", type: "input", value: "1" },
        { id: "a", type: "input", value: "2" },
        { id: "out", type: "output", ref: "a" },
      ]),
    ).toThrow(KernelError);
    expect(() =>
      evaluateGraph([
        { id: "a", type: "input", value: "nope" },
        { id: "out", type: "output", ref: "a" },
      ]),
    ).toThrow(KernelError);
    expect(() =>
      evaluateGraph([
        { id: "series", type: "timeseries", values: [] },
        { id: "out", type: "output", ref: "series" },
      ]),
    ).toThrow(KernelError);
    expect(() =>
      evaluateGraph([
        { id: "series", type: "timeseries", values: ["1"], period: "nope" },
        { id: "out", type: "output", ref: "series" },
      ]),
    ).toThrow(KernelError);
    expect(() =>
      evaluateGraph([
        { id: "series", type: "timeseries", values: ["1"], period: "3" },
        { id: "out", type: "output", ref: "series" },
      ]),
    ).toThrow(KernelError);
    expect(() =>
      evaluateGraph([
        { id: "total", type: "aggregate", op: "sum", refs: [] },
        { id: "out", type: "output", ref: "total" },
      ]),
    ).toThrow(KernelError);
    expect(() =>
      evaluateGraph([
        { id: "a", type: "input", value: "1" },
        { id: "f", type: "formula", op: "pow" as "add", left: "a", right: "a" },
        { id: "out", type: "output", ref: "f" },
      ]),
    ).toThrow(KernelError);
    expect(() => evaluateGraph([{ id: "x", type: "mystery" } as unknown as CalcNode])).toThrow(
      KernelError,
    );

    const summed = evaluateGraph([
      { id: "a", type: "input", value: "2" },
      { id: "b", type: "input", value: "3" },
      { id: "total", type: "aggregate", op: "sum", refs: ["a", "b"] },
      { id: "series", type: "timeseries", values: ["9", "8"], period: "0" },
      { id: "latest", type: "timeseries", values: ["4"] },
      { id: "linked", type: "link", ref: "total" },
      { id: "out", type: "output", ref: "linked" },
    ]);
    expect(summed.outputs.out).toBe("5.000000000000");
  });
});
