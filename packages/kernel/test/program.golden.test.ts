import { describe, expect, it } from "vitest";

import {
  acceptCitedClaims,
  applyDealScenario,
  assertMakerChecker,
  assertSourcesEqualUses,
  attributeNonControllingInterest,
  buildQoeBridge,
  evaluateGraph,
  lboReturns,
  mapReportingBasis,
  reconcileCapTable,
  resolveOwnership,
  rollDebt,
  stateHash,
  translateTrialBalance,
  valueDcf,
  valueDcfSensitivity,
  type FxRate,
} from "../src/index.js";

const rate = (value: string): FxRate => ({
  rateSetId: "rates-2024",
  base: "USD",
  quote: "EUR",
  rate: value,
  rounding: "half_even",
});

describe("published state hash", () => {
  it("ignores presentation fields that are outside the allow-list", () => {
    const allow = ["entityId", "periodId", "netIncomeMinor"] as const;
    const left = stateHash(
      { entityId: "e1", periodId: "p1", netIncomeMinor: "50000", label: "Draft" },
      allow,
    );
    const right = stateHash(
      { entityId: "e1", periodId: "p1", netIncomeMinor: "50000", label: "Published" },
      allow,
    );
    expect(left).toBe(right);
    expect(left).toHaveLength(64);
  });
});

describe("group translation and ownership", () => {
  it("plugs CTA when closing and historical rates differ", () => {
    const translated = translateTrialBalance({
      sourceCurrency: "USD",
      ctaAccountId: "cta",
      lines: [
        { accountId: "cash", rateType: "closing", debitPositiveMinor: "10000" },
        { accountId: "equity", rateType: "historical", debitPositiveMinor: "-10000" },
      ],
      rates: {
        closing: rate("0.90"),
        historical: rate("0.80"),
        average: rate("0.85"),
      },
    });
    const byAccount = new Map(
      translated.lines.map((line) => [line.accountId, line.debitPositiveMinor]),
    );
    expect(byAccount.get("cash")).toBe("9000");
    expect(byAccount.get("equity")).toBe("-8000");
    expect(byAccount.get("cta")).toBe("-1000");
    expect(translated.ctaMinor).toBe("-1000");
    const total = translated.lines.reduce((sum, line) => sum + BigInt(line.debitPositiveMinor), 0n);
    expect(total).toBe(0n);
  });

  it("resolves ownership as of the reporting date and attributes NCI", () => {
    const ownership = resolveOwnership({
      asOf: "2024-12-31",
      parentEntityId: "parent",
      childEntityId: "sub",
      edges: [
        {
          parentEntityId: "parent",
          childEntityId: "sub",
          effectiveFrom: "2024-01-01",
          effectiveTo: null,
          percent: "0.60",
        },
      ],
    });
    expect(ownership.percent).toBe("0.600000000000");
    const nci = attributeNonControllingInterest({
      subsidiaryEquityMinor: "-100000",
      ownershipPercent: ownership.percent,
    });
    expect(nci.parentEquityMinor).toBe("-60000");
    expect(nci.nciMinor).toBe("-40000");
    expect(BigInt(nci.parentEquityMinor) + BigInt(nci.nciMinor)).toBe(-100000n);
  });
});

describe("models, valuation sensitivity, and deals", () => {
  it("evaluates link, timeseries, and aggregate nodes", () => {
    const result = evaluateGraph([
      { id: "y1", type: "timeseries", values: ["10", "12"], period: "0" },
      { id: "y2", type: "timeseries", values: ["10", "12"], period: "1" },
      { id: "linked", type: "link", ref: "y2" },
      { id: "total", type: "aggregate", op: "sum", refs: ["y1", "linked"] },
      { id: "out", type: "output", ref: "total" },
    ]);
    expect(result.outputs.out).toBe("22.000000000000");
  });

  it("keeps the base DCF unchanged across shocks", () => {
    const base = {
      currency: "USD",
      freeCashFlows: ["100", "110"],
      wacc: "0.10",
      terminalGrowth: "0.02",
      netDebt: "200",
      nonOperatingAssets: "50",
      otherClaims: "10",
    };
    const direct = valueDcf(base);
    const sensitivity = valueDcfSensitivity({
      base,
      shocks: [{ id: "wacc-up", wacc: "0.12" }],
    });
    expect(direct.enterpriseValue).toBe("1340.909090909091");
    expect(direct.equityValue).toBe("1180.909090909091");
    expect(sensitivity.runs[0]?.result.enterpriseValue).not.toBe(direct.enterpriseValue);
    expect(base.wacc).toBe("0.10");
  });

  it("hashes a deal scenario without changing the published base", () => {
    const base = { growth: "0.05", price: "10" };
    const deal = applyDealScenario({
      publishedStateHash: "a".repeat(64),
      base,
      overrides: { growth: "0.01" },
    });
    expect(base).toEqual({ growth: "0.05", price: "10" });
    expect(deal.scenario.growth).toBe("0.01");
    expect(deal.outputHash).toHaveLength(64);
  });
});

describe("capital, QoE, basis, and citations", () => {
  it("rolls debt, reconciles the cap table, and ties sources to uses", () => {
    const debt = rollDebt({
      openingMinor: "100000",
      drawMinor: "20000",
      repaymentMinor: "5000",
      accruedInterestMinor: "1000",
    });
    expect(debt.closingMinor).toBe("116000");

    const cap = reconcileCapTable([
      { holderId: "a", commonShares: "60", options: "0", convertibles: "0" },
      { holderId: "b", commonShares: "40", options: "0", convertibles: "0" },
    ]);
    expect(cap.fullyDilutedShares).toBe("100");
    expect(cap.ownership[0]?.percent).toBe("0.600000000000");
    expect(cap.ownership[1]?.percent).toBe("0.400000000000");

    const funding = assertSourcesEqualUses({
      sources: [
        { label: "equity", amountMinor: "40000" },
        { label: "debt", amountMinor: debt.drawMinor },
      ],
      uses: [{ label: "purchase", amountMinor: "60000" }],
    });
    expect(funding.totalSourcesMinor).toBe("60000");

    const returns = lboReturns({ entryEquity: "100", exitEquity: "200", holdYears: "5" });
    expect(returns.moic).toBe("2.000000000000");
  });

  it("traces a QoE bridge and stores both basis hashes", () => {
    const bridge = buildQoeBridge({
      reported: "100",
      adjustments: [
        { adjustmentId: "adj-1", sourceRowId: "row-1", actorId: "controller-1", amount: "15" },
      ],
    });
    expect(bridge.normalized).toBe("115.000000000000");
    expect(bridge.steps[0]?.stepHash).toHaveLength(64);

    const basis = mapReportingBasis({
      basisVersion: "local-gaap-2024",
      localBalances: [{ accountId: "local-cash", debitPositiveMinor: "10" }],
      mappings: [{ localAccountId: "local-cash", groupAccountId: "group-cash" }],
    });
    expect(basis.groupBalances).toEqual([{ accountId: "group-cash", debitPositiveMinor: "10" }]);
    expect(basis.localHash).not.toBe(basis.groupHash);
  });

  it("discards an uncited numeric claim and blocks a maker from checking their own publish", () => {
    const claims = acceptCitedClaims([
      { text: "EBITDA is 115", citationId: null },
      { text: "See the published bridge", citationId: "run-1" },
    ]);
    expect(claims.discarded).toHaveLength(1);
    expect(claims.accepted).toHaveLength(1);
    expect(() => assertMakerChecker("owner-1", "owner-1")).toThrowError(
      expect.objectContaining({ code: "PUBLISH_BLOCKED" }),
    );
    expect(() => assertMakerChecker("owner-1", "controller-1")).not.toThrow();
  });
});
