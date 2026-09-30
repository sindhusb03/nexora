import { describe, expect, it } from "vitest";

import {
  KernelError,
  assertCanPublish,
  assertNoPeriodOverlap,
  assertPeriodOpen,
  assertSameRegion,
  assertTransition,
  authorize,
  eliminateIntercompany,
  evaluateGraph,
  projectScenario,
} from "../src/index.js";

describe("calculation graph", () => {
  it("evaluates a formula in dependency order", () => {
    const result = evaluateGraph([
      { id: "revenue", type: "input", value: "100" },
      { id: "cost", type: "input", value: "40" },
      { id: "profit", type: "formula", op: "sub", left: "revenue", right: "cost" },
      { id: "profit_out", type: "output", ref: "profit" },
    ]);
    expect(result.outputs.profit_out).toBe("60.000000000000");
    expect(result.order.indexOf("revenue")).toBeLessThan(result.order.indexOf("profit"));
  });

  it("rejects cycles and division by zero", () => {
    expect(() =>
      evaluateGraph([
        { id: "a", type: "formula", op: "add", left: "b", right: "b" },
        { id: "b", type: "formula", op: "add", left: "a", right: "a" },
        { id: "out", type: "output", ref: "a" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "CALC_CYCLE_DETECTED" }));

    expect(() =>
      evaluateGraph([
        { id: "a", type: "input", value: "1" },
        { id: "z", type: "input", value: "0" },
        { id: "q", type: "formula", op: "div", left: "a", right: "z" },
        { id: "out", type: "output", ref: "q" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "CALC_FAILED" }));
  });
});

describe("publication and scenarios", () => {
  it("blocks publication of a failed calculation and freezes published states", () => {
    expect(() => assertCanPublish({ calculationStatus: "failed", from: "approved" })).toThrowError(
      expect.objectContaining({ code: "PUBLISH_BLOCKED" }),
    );
    expect(() =>
      assertCanPublish({ calculationStatus: "succeeded", from: "approved" }),
    ).not.toThrow();
    expect(() => assertTransition("published", "draft")).toThrow(KernelError);
  });

  it("projects a scenario without changing the base", () => {
    const base = { growth: "0.05", price: "10" };
    const projected = projectScenario(base, { growth: "0.01" });
    expect(base).toEqual({ growth: "0.05", price: "10" });
    expect(projected.scenario).toEqual({ growth: "0.01", price: "10" });
    expect(projected.base).toEqual(base);
    expect(projected.base).not.toBe(base);
  });
});

describe("elimination, periods, and authorization", () => {
  it("eliminates a balanced intercompany pair and keeps the group in balance", () => {
    const result = eliminateIntercompany({
      balances: [
        { accountId: "cash", debitPositiveMinor: "140" },
        { accountId: "ic_receivable", debitPositiveMinor: "10" },
        { accountId: "ic_payable", debitPositiveMinor: "-10" },
        { accountId: "equity", debitPositiveMinor: "-140" },
      ],
      eliminations: [
        { accountId: "ic_payable", debitMinor: "10", creditMinor: "0", evidenceId: "ic-1" },
        { accountId: "ic_receivable", debitMinor: "0", creditMinor: "10", evidenceId: "ic-1" },
      ],
    });
    expect(result.balances).toEqual([
      { accountId: "cash", debitPositiveMinor: "140" },
      { accountId: "equity", debitPositiveMinor: "-140" },
      { accountId: "ic_payable", debitPositiveMinor: "0" },
      { accountId: "ic_receivable", debitPositiveMinor: "0" },
    ]);
  });

  it("rejects overlapping and closed periods", () => {
    expect(() =>
      assertNoPeriodOverlap({ startDate: "2024-06-01", endDate: "2024-12-31" }, [
        { startDate: "2024-01-01", endDate: "2024-12-31" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "FIN_OVERLAPPING_PERIOD" }));
    expect(() => assertPeriodOpen("closed")).toThrowError(
      expect.objectContaining({ code: "FIN_PERIOD_CLOSED" }),
    );
  });

  it("fails closed on missing permission and foreign regions", () => {
    expect(() => authorize(["viewer"], "journal.post")).toThrowError(
      expect.objectContaining({ code: "AUTH_SCOPE_DENIED" }),
    );
    expect(() => authorize([], "statement.read")).toThrow(KernelError);
    expect(() => authorize(["controller"], "journal.post")).not.toThrow();
    expect(() => assertSameRegion("eu-central-1", "us-east-1")).toThrowError(
      expect.objectContaining({ code: "REGION_MISMATCH" }),
    );
  });
});
