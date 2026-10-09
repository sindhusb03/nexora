import { describe, expect, it } from "vitest";

import {
  KernelError,
  assertCanonicalClassification,
  buildStatements,
  canonicalAccount,
  isReviewCashFlowPlaceholder,
  unclassifiedCashFlow,
  type ClassifiedLine,
  type StatementPolicy,
  type StatementSet,
} from "../src/index.js";

function leg(
  accountId: string,
  report: ClassifiedLine["report"],
  cashFlow: ClassifiedLine["cashFlow"],
  debit: number,
  credit: number,
  journalId: string,
  extras: {
    accountCode?: string;
    sourceLabel?: string;
    journalKind?: "opening";
    period?: ClassifiedLine["period"];
    periodEnd?: string;
  } = {},
): ClassifiedLine {
  return {
    accountId,
    report,
    cashFlow,
    debitMinor: String(debit),
    creditMinor: String(credit),
    currency: "USD",
    period: extras.period ?? "movement",
    journalId,
    ...(extras.accountCode === undefined ? {} : { accountCode: extras.accountCode }),
    ...(extras.sourceLabel === undefined ? {} : { sourceLabel: extras.sourceLabel }),
    ...(extras.journalKind === undefined ? {} : { journalKind: extras.journalKind }),
    ...(extras.periodEnd === undefined ? {} : { periodEnd: extras.periodEnd }),
  };
}

function run(lines: readonly ClassifiedLine[], policy?: StatementPolicy): StatementSet {
  return buildStatements({
    currency: "USD",
    retainedEarningsAccountId: "re",
    lines,
    ...(policy === undefined ? {} : { policy }),
  });
}

function sale(proceeds: number, gain: number, loss: number, gainCode: string | undefined) {
  const lines = [
    leg("cash", "asset", "cash", proceeds, 0, "sale"),
    leg("accum", "asset", "non_cash", 600, 0, "sale", { accountCode: "accumulated_depreciation" }),
    leg("fa", "asset", "cfi", 0, 800, "sale", { accountCode: "fixed_assets" }),
  ];
  if (gain > 0) {
    lines.push(
      leg("gain", "revenue", gainCode ? "cfi" : "cfo", 0, gain, "sale", {
        ...(gainCode === undefined ? {} : { accountCode: gainCode }),
      }),
    );
  }
  if (loss > 0) {
    lines.push(
      leg("loss", "expense", "cfi", loss, 0, "sale", { accountCode: "gain_loss_on_disposal" }),
    );
  }
  return lines;
}

describe("statement class taxonomy goldens", () => {
  it("keeps canonical cash-flow classes and refuses an automatic non-cash class", () => {
    expect(canonicalAccount("deferred_tax_liability")?.cashFlow).toBe("non_cash");
    expect(canonicalAccount("deferred_revenue")?.cashFlow).toBe("cfo");
    expect(canonicalAccount("capex_payables")?.cashFlow).toBe("cfi");
    expect(canonicalAccount("depreciation_rou")?.cashFlow).toBe("non_cash");
    expect(canonicalAccount("oci_reserves")?.cashFlow).toBe("non_cash");
    expect(canonicalAccount("asset_sale_receivable")?.cashFlow).toBe("cfi");
    expect(canonicalAccount("other_current_assets")?.cashFlow).toBe("cfo");
    expect(canonicalAccount("other_noncurrent_assets")?.cashFlow).toBe("non_cash");
    expect(canonicalAccount("other_noncurrent_liabilities")?.cashFlow).toBe("non_cash");
    expect(isReviewCashFlowPlaceholder("other_noncurrent_assets")).toBe(true);
    expect(isReviewCashFlowPlaceholder("cash")).toBe(false);
    expect(() =>
      assertCanonicalClassification({
        code: "other_noncurrent_assets",
        report: "asset",
        cashFlow: "non_cash",
      }),
    ).toThrow(/cannot be classified/);
    expect(() =>
      assertCanonicalClassification({
        code: "other_noncurrent_liabilities",
        report: "liability",
        cashFlow: "non_cash",
      }),
    ).toThrow(/cannot be classified/);
    expect(() =>
      assertCanonicalClassification({
        code: "other_noncurrent_assets",
        report: "asset",
        cashFlow: "cfi",
      }),
    ).not.toThrow();
    expect(() =>
      assertCanonicalClassification({
        code: "other_noncurrent_liabilities",
        report: "liability",
        cashFlow: "cfo",
      }),
    ).not.toThrow();
    expect(canonicalAccount("amortisation")?.name).toBe("Amortization");
    expect(unclassifiedCashFlow("current")).toBe("cfo");
    expect(unclassifiedCashFlow("noncurrent")).toBe("review");
    expect(() =>
      assertCanonicalClassification({
        code: "other_noncurrent_assets",
        report: "asset",
        cashFlow: "cash",
      }),
    ).toThrow(KernelError);
    expect(() =>
      assertCanonicalClassification({
        code: "security_deposits_paid",
        report: "asset",
        cashFlow: "cfo",
      }),
    ).not.toThrow();
    expect(() =>
      assertCanonicalClassification({ code: "1000", report: "asset", cashFlow: "non_cash" }),
    ).not.toThrow();
  });

  it("G37 classifies a mapped disposal, a loss, and an unmapped gain", () => {
    const gain = run(sale(300, 100, 0, "gain_loss_on_disposal"));
    expect(gain.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "300" });
    expect(gain.notices.map((item) => item.code)).not.toContain("disposal_gain_unmapped");

    const loss = run(sale(150, 0, 50, undefined));
    expect(loss.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "150" });

    const unmapped = run(sale(300, 100, 0, undefined));
    expect(unmapped.cashFlow).toMatchObject({ cfoMinor: "100", cfiMinor: "200" });
    expect(unmapped.notices).toEqual([
      expect.objectContaining({
        code: "disposal_gain_unmapped",
        severity: "notice",
        sourceLabel: null,
      }),
    ]);
    expect(unmapped.issues).toEqual([]);
  });

  it("G37c keeps proceeds when ROU depreciation shares the D&A line and blocks the unsplit line", () => {
    const split = run([
      ...sale(300, 100, 0, "gain_loss_on_disposal"),
      leg("ppe-dep", "expense", "non_cash", 1000, 0, "ppe", { accountCode: "depreciation_ppe" }),
      leg("accum", "asset", "non_cash", 0, 1000, "ppe", {
        accountCode: "accumulated_depreciation",
      }),
      leg("rou-dep", "expense", "non_cash", 200, 0, "rou", { accountCode: "depreciation_rou" }),
      leg("rou-accum", "asset", "non_cash", 0, 200, "rou", {
        accountCode: "rou_accumulated_depreciation",
      }),
    ]);
    expect(split.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "300" });
    expect(split.issues).toEqual([]);

    const unsplit = run([
      ...sale(300, 100, 0, "gain_loss_on_disposal"),
      leg("da", "expense", "non_cash", 1200, 0, "da", {
        accountCode: "depreciation",
        sourceLabel: "Depreciation & amortisation",
      }),
      leg("accum", "asset", "non_cash", 0, 1000, "da", { accountCode: "accumulated_depreciation" }),
      leg("rou-accum", "asset", "non_cash", 0, 200, "da", {
        accountCode: "rou_accumulated_depreciation",
      }),
    ]);
    expect(unsplit.cashFlow.cfiMinor).toBe("300");
    expect(unsplit.cashFlow.cfiMinor).not.toBe("100");
    expect(unsplit.issues).toEqual([
      expect.objectContaining({
        code: "depreciation_split_needed",
        severity: "error",
        sourceLabel: null,
      }),
    ]);
  });

  it("G37d and G37f are notice-only when nothing fell and the charge is counted once", () => {
    const quiet = run([
      leg("da", "expense", "non_cash", 1200, 0, "da", {
        accountCode: "depreciation",
        sourceLabel: "Depreciation & amortisation",
      }),
      leg("accum", "asset", "non_cash", 0, 1000, "da", { accountCode: "accumulated_depreciation" }),
      leg("rou-accum", "asset", "non_cash", 0, 200, "da", {
        accountCode: "rou_accumulated_depreciation",
      }),
    ]);
    expect(quiet.issues).toEqual([]);
    expect(quiet.notices).toEqual([
      expect.objectContaining({
        code: "depreciation_split_needed",
        severity: "notice",
        sourceLabel: null,
      }),
    ]);
    expect(quiet.cashFlow.cfiMinor).toBe("0");

    const mixed = run([
      leg("ppe-dep", "expense", "non_cash", 1000, 0, "ppe", { accountCode: "depreciation_ppe" }),
      leg("accum", "asset", "non_cash", 0, 1000, "ppe", {
        accountCode: "accumulated_depreciation",
      }),
      leg("da", "expense", "non_cash", 200, 0, "rou", {
        accountCode: "depreciation",
        sourceLabel: "Depreciation & amortisation",
      }),
      leg("rou-accum", "asset", "non_cash", 0, 200, "rou", {
        accountCode: "rou_accumulated_depreciation",
      }),
    ]);
    expect(mixed.issues).toEqual([]);
    expect(mixed.notices.map((item) => item.code)).toEqual(["depreciation_split_needed"]);
    expect(mixed.cashFlow.cfiMinor).toBe("0");
  });

  it("G37e puts an intangible sale in investing", () => {
    const result = run([
      leg("amort", "expense", "non_cash", 40, 0, "amort", { accountCode: "amortisation" }),
      leg("accum", "asset", "cfi", 0, 40, "amort", { accountCode: "accumulated_amortisation" }),
      leg("cash", "asset", "cash", 250, 0, "sale"),
      leg("accum", "asset", "cfi", 300, 0, "sale", { accountCode: "accumulated_amortisation" }),
      leg("intangible", "asset", "cfi", 0, 500, "sale", { accountCode: "intangible_assets" }),
      leg("gain", "revenue", "cfi", 0, 50, "sale", { accountCode: "gain_loss_on_disposal" }),
    ]);
    expect(result.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "250" });
    expect(result.incomeStatement.netIncomeMinor).toBe("10");
    expect(result.issues).toEqual([]);
  });

  it("G37g returns the impairment line notice and the period error together", () => {
    const unsplit = run([
      ...sale(300, 100, 0, "gain_loss_on_disposal"),
      leg("imp", "expense", "non_cash", 50, 0, "imp", {
        accountCode: "depreciation",
        sourceLabel: "Impairment loss",
      }),
      leg("accum", "asset", "non_cash", 0, 50, "imp", { accountCode: "accumulated_depreciation" }),
    ]);
    expect(unsplit.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "300" });
    expect(unsplit.cashFlow.cfiMinor).not.toBe("350");
    expect(unsplit.notices).toEqual([
      expect.objectContaining({
        code: "depreciation_split_needed",
        severity: "notice",
        sourceLabel: "Impairment loss",
      }),
    ]);
    expect(unsplit.issues).toEqual([
      expect.objectContaining({
        code: "depreciation_split_needed",
        severity: "error",
        sourceLabel: null,
      }),
    ]);

    const split = run([
      ...sale(300, 100, 0, "gain_loss_on_disposal"),
      leg("imp", "expense", "non_cash", 50, 0, "imp", {
        accountCode: "impairment",
        sourceLabel: "Impairment loss",
      }),
      leg("accum", "asset", "non_cash", 0, 50, "imp", { accountCode: "accumulated_depreciation" }),
    ]);
    expect(split.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "300" });
    expect(split.incomeStatement.netIncomeMinor).toBe("50");
    expect(split.issues).toEqual([]);
    expect(split.notices).toEqual([]);
  });

  it("treats a two-account rounding gap of 2 as a notice and a gap of 3 as an error", () => {
    const base = [
      leg("da", "expense", "non_cash", 1000, 0, "da", {
        accountCode: "depreciation",
        sourceLabel: "Depreciation & amortisation",
      }),
      leg("accum-a", "asset", "non_cash", 0, 500, "da", {
        accountCode: "accumulated_depreciation",
      }),
      leg("accum-b", "asset", "non_cash", 0, 500, "da", {
        accountCode: "accumulated_amortisation",
      }),
    ];
    const notice = run([
      ...base,
      leg("accum-a", "asset", "non_cash", 2, 0, "drop", {
        accountCode: "accumulated_depreciation",
      }),
      leg("cash", "asset", "cash", 0, 2, "drop"),
    ]);
    expect(notice.issues).toEqual([]);
    expect(notice.notices.map((item) => item.code)).toContain("depreciation_split_needed");

    const error = run([
      ...base,
      leg("accum-a", "asset", "non_cash", 3, 0, "drop", {
        accountCode: "accumulated_depreciation",
      }),
      leg("cash", "asset", "cash", 0, 3, "drop"),
    ]);
    expect(error.issues).toEqual([
      expect.objectContaining({ code: "depreciation_split_needed", severity: "error" }),
    ]);
    expect(error.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "-3" });
  });

  it("G38 classifies an IFRS 16 lease under both interest policies", () => {
    const lines = [
      leg("rou", "asset", "non_cash", 1000, 0, "new", { accountCode: "rou_assets" }),
      leg("liab", "liability", "cff", 0, 1000, "new", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("rou-dep", "expense", "non_cash", 200, 0, "dep", { accountCode: "depreciation_rou" }),
      leg("rou", "asset", "non_cash", 0, 200, "dep", { accountCode: "rou_assets" }),
      leg("interest", "expense", "cff", 60, 0, "pay", { accountCode: "interest_expense" }),
      leg("liab", "liability", "cff", 190, 0, "pay", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("cash", "asset", "cash", 0, 250, "pay"),
    ];
    const operating = run(lines, { leaseAccounting: "ifrs16", interestPaid: "cfo" });
    expect(operating.cashFlow).toMatchObject({ cfoMinor: "-60", cfiMinor: "0", cffMinor: "-190" });
    expect(operating.nonCash.leaseAdditionsMinor).toBe("1000");
    expect(operating.issues).toEqual([]);

    const financing = run(lines, { leaseAccounting: "ifrs16", interestPaid: "cff" });
    expect(financing.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "0", cffMinor: "-250" });
    expect(financing.nonCash.leaseAdditionsMinor).toBe("1000");
  });

  it("G38b classifies an ASC 842 operating lease payment entirely as operating", () => {
    const result = run(
      [
        leg("rou", "asset", "non_cash", 1000, 0, "new", { accountCode: "rou_assets" }),
        leg("liab", "liability", "cff", 0, 1000, "new", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("cost", "expense", "cfo", 60, 0, "accrete"),
        leg("liab", "liability", "cff", 0, 60, "accrete", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("cost", "expense", "cfo", 160, 0, "amort"),
        leg("rou", "asset", "non_cash", 0, 160, "amort", { accountCode: "rou_assets" }),
        leg("liab", "liability", "cff", 250, 0, "pay", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("cash", "asset", "cash", 0, 250, "pay"),
      ],
      { leaseAccounting: "asc842_operating" },
    );
    expect(result.cashFlow).toMatchObject({ cfoMinor: "-250", cfiMinor: "0", cffMinor: "0" });
    expect(result.nonCash.leaseAdditionsMinor).toBe("1000");
    expect(result.incomeStatement.netIncomeMinor).toBe("-220");
  });

  it("G38c derives additions from gross right-of-use cost when accumulated depreciation did not fall", () => {
    const lines = [
      leg("rou", "asset", "non_cash", 1000, 0, "new", { accountCode: "rou_assets" }),
      leg("liab", "liability", "cff", 0, 1000, "new", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("rou-accum", "asset", "non_cash", 0, 0, "mapped", {
        accountCode: "rou_accumulated_depreciation",
      }),
      leg("interest", "expense", "cff", 60, 0, "pay", { accountCode: "interest_expense" }),
      leg("liab", "liability", "cff", 190, 0, "pay", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("cash", "asset", "cash", 0, 250, "pay"),
    ];
    const result = run(lines, { interestPaid: "cfo" });
    expect(result.nonCash.leaseAdditionsMinor).toBe("1000");
    expect(result.cashFlow.cffMinor).toBe("-190");
    expect(result.issues.map((item) => item.code)).not.toContain("lease_additions_needed");

    expect(() =>
      run([
        leg("rou", "asset", "non_cash", 1000, 0, "new", { accountCode: "rou_assets" }),
        leg("liab", "liability", "cff", 0, 1000, "new", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("da", "expense", "non_cash", 200, 0, "dep", { accountCode: "depreciation" }),
        leg("rou", "asset", "non_cash", 0, 200, "dep", { accountCode: "rou_assets" }),
        leg("liab", "liability", "cff", 190, 0, "pay", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("cash", "asset", "cash", 0, 190, "pay"),
      ]),
    ).toThrow(/lease_additions_needed/);

    const separable = run([
      leg("rou", "asset", "non_cash", 1000, 0, "new", { accountCode: "rou_assets" }),
      leg("liab", "liability", "cff", 0, 1000, "new", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("rou-dep", "expense", "non_cash", 200, 0, "dep", { accountCode: "depreciation_rou" }),
      leg("rou", "asset", "non_cash", 0, 200, "dep", { accountCode: "rou_assets" }),
      leg("liab", "liability", "cff", 190, 0, "pay", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("cash", "asset", "cash", 0, 190, "pay"),
    ]);
    expect(separable.issues).toEqual([]);
    expect(separable.nonCash.leaseAdditionsMinor).toBe("1000");
  });

  it("G38d refuses a lease ending inside a combined depreciation line and derives the split", () => {
    const common = [
      leg("rou", "asset", "non_cash", 1000, 0, "new", { accountCode: "rou_assets" }),
      leg("liab", "liability", "cff", 0, 1000, "new", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("rou-accum", "asset", "non_cash", 300, 0, "end", {
        accountCode: "rou_accumulated_depreciation",
      }),
      leg("rou", "asset", "non_cash", 0, 300, "end", { accountCode: "rou_assets" }),
      leg("interest", "expense", "cff", 60, 0, "pay", { accountCode: "interest_expense" }),
      leg("liab", "liability", "cff", 190, 0, "pay", {
        accountCode: "lease_liabilities_noncurrent",
      }),
      leg("cash", "asset", "cash", 0, 250, "pay"),
    ];
    const combined = [
      ...common,
      leg("da", "expense", "non_cash", 1200, 0, "da", {
        accountCode: "depreciation",
        sourceLabel: "Depreciation & amortisation",
      }),
      leg("ppe-accum", "asset", "non_cash", 0, 1000, "da", {
        accountCode: "accumulated_depreciation",
      }),
      leg("rou-accum", "asset", "non_cash", 0, 200, "da", {
        accountCode: "rou_accumulated_depreciation",
      }),
    ];
    expect(() => run(combined, { interestPaid: "cfo" })).toThrow(/lease_additions_needed/);
    expect(() => run(combined, { interestPaid: "cfo" })).toThrow(/depreciation_split_needed/);

    const split = run(
      [
        ...common,
        leg("ppe-dep", "expense", "non_cash", 1000, 0, "ppe", { accountCode: "depreciation_ppe" }),
        leg("ppe-accum", "asset", "non_cash", 0, 1000, "ppe", {
          accountCode: "accumulated_depreciation",
        }),
        leg("rou-dep", "expense", "non_cash", 200, 0, "rou", { accountCode: "depreciation_rou" }),
        leg("rou-accum", "asset", "non_cash", 0, 200, "rou", {
          accountCode: "rou_accumulated_depreciation",
        }),
      ],
      { interestPaid: "cfo" },
    );
    expect(split.nonCash.leaseAdditionsMinor).toBe("1000");
    expect(split.cashFlow.cffMinor).toBe("-190");
    expect(split.issues.map((item) => item.code)).not.toContain("lease_additions_needed");
    expect(split.issues.map((item) => item.code)).not.toContain("depreciation_split_needed");
  });

  it("classifies one cash leg across revenue, expense, capex and debt", () => {
    const result = run([
      leg("cash", "asset", "cash", 200, 0, "mix"),
      leg("expense", "expense", "cfo", 900, 0, "mix"),
      leg("capex", "asset", "cfi", 400, 0, "mix"),
      leg("revenue", "revenue", "cfo", 0, 1000, "mix"),
      leg("loan", "liability", "cff", 0, 500, "mix"),
    ]);
    expect(result.cashFlow).toMatchObject({ cfoMinor: "100", cfiMinor: "-400", cffMinor: "500" });
  });

  it("keeps an opening journal off the cash flow and rolls a direct retained-earnings entry", () => {
    const result = run([
      leg("cash", "asset", "cash", 42_000_000, 0, "open", { journalKind: "opening" }),
      leg("ar", "asset", "cfo", 9_500_000, 0, "open", { journalKind: "opening" }),
      leg("equip", "asset", "cfi", 6_000_000, 0, "open", { journalKind: "opening" }),
      leg("ap", "liability", "cfo", 0, 4_000_000, "open", { journalKind: "opening" }),
      leg("def", "liability", "cfo", 0, 2_500_000, "open", { journalKind: "opening" }),
      leg("loan", "liability", "cff", 0, 18_000_000, "open", { journalKind: "opening" }),
      leg("stock", "equity", "cff", 0, 14_000_000, "open", { journalKind: "opening" }),
      leg("re", "equity", "non_cash", 0, 19_000_000, "open", { journalKind: "opening" }),
      leg("re", "equity", "non_cash", 100, 0, "ias8"),
      leg("restatement", "liability", "cfo", 0, 100, "ias8"),
    ]);
    expect(result.cashFlow).toMatchObject({
      beginningCashMinor: "42000000",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "42000000",
    });
    expect(result.retainedEarnings).toMatchObject({
      openingMinor: "19000000",
      netIncomeMinor: "0",
      distributionsMinor: "0",
      directEntriesMinor: "-100",
      endingMinor: "18999900",
    });
    expect(result.balanceSheet.assetsMinor).toBe("57500000");
  });

  it("ties a Schedule III movement across operating, investing and non-cash tax", () => {
    const result = run([
      leg("cash", "asset", "cash", 1000, 0, "open", { period: "opening" }),
      leg("contract", "asset", "cfo", 60, 0, "open", {
        period: "opening",
        accountCode: "contract_assets",
      }),
      leg("re", "equity", "non_cash", 0, 1060, "open", { period: "opening" }),
      leg("cash", "asset", "cash", 500, 0, "rev"),
      leg("revenue", "revenue", "cfo", 0, 500, "rev"),
      leg("itc", "asset", "cfo", 40, 0, "itc", { accountCode: "indirect_tax_receivable" }),
      leg("cash", "asset", "cash", 0, 40, "itc"),
      leg("cash", "asset", "cash", 25, 0, "itp"),
      leg("itp", "liability", "cfo", 0, 25, "itp", { accountCode: "indirect_tax_payable" }),
      leg("wht-r", "asset", "cfo", 10, 0, "whtr", { accountCode: "withholding_tax_receivable" }),
      leg("cash", "asset", "cash", 0, 10, "whtr"),
      leg("cash", "asset", "cash", 15, 0, "whtp"),
      leg("wht-p", "liability", "cfo", 0, 15, "whtp", { accountCode: "withholding_tax_payable" }),
      leg("adv", "asset", "cfo", 20, 0, "adv", { accountCode: "income_tax_receivable" }),
      leg("cash", "asset", "cash", 0, 20, "adv"),
      leg("cash", "asset", "cash", 35, 0, "taxp"),
      leg("taxp", "liability", "cfo", 0, 35, "taxp", { accountCode: "income_tax_payable" }),
      leg("cash", "asset", "cash", 50, 0, "defrev"),
      leg("defrev", "liability", "cfo", 0, 50, "defrev", { accountCode: "deferred_revenue" }),
      leg("cash", "asset", "cash", 60, 0, "unbilled"),
      leg("contract", "asset", "cfo", 0, 60, "unbilled", { accountCode: "contract_assets" }),
      leg("cash", "asset", "cash", 12, 0, "prov"),
      leg("prov", "liability", "cfo", 0, 12, "prov", { accountCode: "provisions" }),
      leg("cash", "asset", "cash", 8, 0, "pay"),
      leg("payroll", "liability", "cfo", 0, 8, "pay", { accountCode: "payroll_liabilities" }),
      leg("cash", "asset", "cash", 7, 0, "ptax"),
      leg("ptax", "liability", "cfo", 0, 7, "ptax", { accountCode: "payroll_tax_payable" }),
      leg("fa", "asset", "cfi", 100, 0, "capex"),
      leg("capex", "liability", "cfi", 0, 100, "capex", { accountCode: "capex_payables" }),
      leg("capex", "liability", "cfi", 100, 0, "capex-pay", { accountCode: "capex_payables" }),
      leg("cash", "asset", "cash", 0, 100, "capex-pay"),
      leg("advance", "asset", "cfi", 40, 0, "cadv", { accountCode: "capital_advances" }),
      leg("cash", "asset", "cash", 0, 40, "cadv"),
      leg("sec-c", "asset", "cfo", 15, 0, "secc", { accountCode: "security_deposits_paid" }),
      leg("cash", "asset", "cash", 0, 15, "secc"),
      leg("sec-n", "asset", "cfi", 18, 0, "secn", { accountCode: "security_deposits_paid" }),
      leg("cash", "asset", "cash", 0, 18, "secn"),
      leg("cash", "asset", "cash", 9, 0, "cust"),
      leg("cust", "liability", "cfo", 0, 9, "cust", { accountCode: "customer_deposits" }),
      leg("tax", "expense", "cfo", 20, 0, "dtl"),
      leg("dtl", "liability", "non_cash", 0, 20, "dtl", { accountCode: "deferred_tax_liability" }),
      leg("dta", "asset", "non_cash", 5, 0, "dta", { accountCode: "deferred_tax_asset" }),
      leg("tax", "expense", "cfo", 0, 5, "dta"),
      leg("re", "equity", "non_cash", 11, 0, "oci"),
      leg("oci", "equity", "non_cash", 0, 11, "oci", { accountCode: "oci_reserves" }),
    ]);
    expect(result.cashFlow).toMatchObject({
      beginningCashMinor: "1000",
      cfoMinor: "636",
      cfiMinor: "-158",
      cffMinor: "0",
      endingCashMinor: "1478",
    });
    expect(result.retainedEarnings.directEntriesMinor).toBe("-11");
    expect(() =>
      run([
        leg("cash", "asset", "cash", 10, 0, "bad"),
        leg("dtl", "liability", "non_cash", 0, 10, "bad", {
          accountCode: "deferred_tax_liability",
        }),
      ]),
    ).toThrow(/Deferred tax is never cash-settled/);
  });

  it("adds back share-based pay so a non-cash reserve credit does not hit cash flow", () => {
    const result = run([
      leg("sbc", "expense", "cfo", 500, 0, "sbc"),
      leg("reserve", "equity", "non_cash", 0, 500, "sbc", { accountCode: "oci_reserves" }),
    ]);
    expect(result.cashFlow).toEqual({
      beginningCashMinor: "0",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "0",
    });
    expect(result.incomeStatement.netIncomeMinor).toBe("-500");
    expect(result.balanceSheet).toMatchObject({
      assetsMinor: "0",
      liabilitiesMinor: "0",
      equityMinor: "0",
    });

    const financingReserve = run([
      leg("sbc", "expense", "cfo", 500, 0, "sbc"),
      leg("apic", "equity", "cff", 0, 500, "sbc"),
    ]);
    expect(financingReserve.cashFlow.cffMinor).toBe("0");
    expect(financingReserve.cashFlow.cfoMinor).toBe("0");
  });

  it("keeps a credit sale out of cash flow until the receivable is collected", () => {
    const sale = [
      leg("ar", "asset", "cfi", 300, 0, "sale", { accountCode: "asset_sale_receivable" }),
      leg("fa", "asset", "cfi", 0, 200, "sale", { accountCode: "fixed_assets" }),
      leg("gain", "revenue", "cfi", 0, 100, "sale", { accountCode: "gain_loss_on_disposal" }),
    ];
    const recorded = run(sale);
    expect(recorded.cashFlow).toEqual({
      beginningCashMinor: "0",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "0",
    });
    expect(recorded.incomeStatement.netIncomeMinor).toBe("100");
    expect(recorded.balanceSheet.assetsMinor).toBe(recorded.balanceSheet.equityMinor);
    expect(recorded.nonCash.items).toEqual([
      expect.objectContaining({
        type: "deferred_consideration",
        amountMinor: "300",
        message: "PP&E disposed of for deferred consideration",
      }),
    ]);

    const collected = run([
      ...sale,
      leg("cash", "asset", "cash", 300, 0, "collect"),
      leg("ar", "asset", "cfi", 0, 300, "collect", { accountCode: "asset_sale_receivable" }),
      leg("trade", "asset", "cfo", 40, 0, "accrual"),
      leg("revenue", "revenue", "cfo", 0, 40, "accrual"),
      leg("cash", "asset", "cash", 40, 0, "trade-collect"),
      leg("trade", "asset", "cfo", 0, 40, "trade-collect"),
    ]);
    expect(collected.cashFlow).toEqual({
      beginningCashMinor: "0",
      cfoMinor: "40",
      cfiMinor: "300",
      cffMinor: "0",
      endingCashMinor: "340",
    });
    expect(collected.incomeStatement.netIncomeMinor).toBe("140");
    expect(collected.nonCash.items).toEqual([]);

    const later = run([
      ...sale.map((line) => ({ ...line, period: "opening" as const })),
      leg("cash", "asset", "cash", 300, 0, "collect"),
      leg("ar", "asset", "cfi", 0, 300, "collect", { accountCode: "asset_sale_receivable" }),
    ]);
    expect(later.cashFlow).toMatchObject({
      cfoMinor: "0",
      cfiMinor: "300",
      endingCashMinor: "300",
    });
    expect(later.incomeStatement.netIncomeMinor).toBe("0");
    expect(later.balanceSheet.assetsMinor).toBe(later.balanceSheet.equityMinor);

    const trade = run([
      leg("ar", "asset", "cfo", 300, 0, "sale", { accountCode: "accounts_receivable" }),
      leg("fa", "asset", "cfi", 0, 200, "sale", { accountCode: "fixed_assets" }),
      leg("gain", "revenue", "cfi", 0, 100, "sale", { accountCode: "gain_loss_on_disposal" }),
      leg("cash", "asset", "cash", 300, 0, "collect"),
      leg("ar", "asset", "cfo", 0, 300, "collect", { accountCode: "accounts_receivable" }),
    ]);
    expect(trade.cashFlow).toMatchObject({ cfoMinor: "300", cfiMinor: "0" });
    expect(trade.notices.map((item) => item.code)).toContain("asset_sale_in_trade_receivable");
  });

  it("G37h scraps an asset with accumulated depreciation and no proceeds", () => {
    const scrap = run([
      leg("accum", "asset", "non_cash", 600, 0, "scrap", {
        accountCode: "accumulated_depreciation",
      }),
      leg("loss", "expense", "cfi", 200, 0, "scrap", { accountCode: "gain_loss_on_disposal" }),
      leg("fa", "asset", "cfi", 0, 800, "scrap", { accountCode: "fixed_assets" }),
    ]);
    expect(scrap.incomeStatement.netIncomeMinor).toBe("-200");
    expect(scrap.cashFlow).toEqual({
      beginningCashMinor: "0",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "0",
    });
    expect(scrap.nonCash.items).toEqual([]);
    expect(scrap.issues).toEqual([]);
    expect(scrap.notices).toEqual([]);

    const unmapped = run([
      leg("accum", "asset", "non_cash", 600, 0, "scrap", {
        accountCode: "accumulated_depreciation",
      }),
      leg("opex", "expense", "cfo", 200, 0, "scrap"),
      leg("fa", "asset", "cfi", 0, 800, "scrap", { accountCode: "fixed_assets" }),
    ]);
    expect(unmapped.incomeStatement.netIncomeMinor).toBe("-200");
    expect(unmapped.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "0", cffMinor: "0" });
    expect(unmapped.nonCash.items).toEqual([]);
    expect(unmapped.issues).toEqual([]);
    expect(unmapped.notices.map((item) => item.code)).toEqual(["disposal_gain_unmapped"]);
  });

  it("G37i discloses this period's credit sale and leaves a later month's note empty", () => {
    const sale = [
      leg("recv", "asset", "cfi", 300, 0, "sale", { accountCode: "asset_sale_receivable" }),
      leg("accum", "asset", "non_cash", 600, 0, "sale", {
        accountCode: "accumulated_depreciation",
      }),
      leg("fa", "asset", "cfi", 0, 800, "sale", { accountCode: "fixed_assets" }),
      leg("gain", "revenue", "cfi", 0, 100, "sale", { accountCode: "gain_loss_on_disposal" }),
    ];
    const recorded = run(sale);
    expect(recorded.incomeStatement.netIncomeMinor).toBe("100");
    expect(recorded.cashFlow).toMatchObject({
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "0",
    });
    expect(recorded.nonCash.items).toEqual([
      {
        type: "deferred_consideration",
        amountMinor: "300",
        message: "PP&E disposed of for deferred consideration",
      },
    ]);
    expect(recorded.issues).toEqual([]);

    const monthTwo = run(sale.map((line) => ({ ...line, period: "opening" as const })));
    expect(monthTwo.nonCash.items).toEqual([]);
    expect(monthTwo.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "0", cffMinor: "0" });

    const collected = run([
      ...sale.map((line) => ({ ...line, period: "opening" as const })),
      leg("cash", "asset", "cash", 300, 0, "collect"),
      leg("recv", "asset", "cfi", 0, 300, "collect", { accountCode: "asset_sale_receivable" }),
    ]);
    expect(collected.incomeStatement.netIncomeMinor).toBe("0");
    expect(collected.cashFlow).toMatchObject({
      cfoMinor: "0",
      cfiMinor: "300",
      cffMinor: "0",
      endingCashMinor: "300",
    });
    expect(collected.nonCash.items).toEqual([]);

    const samePeriod = run([
      ...sale,
      leg("cash", "asset", "cash", 300, 0, "collect"),
      leg("recv", "asset", "cfi", 0, 300, "collect", { accountCode: "asset_sale_receivable" }),
    ]);
    expect(samePeriod.incomeStatement.netIncomeMinor).toBe("100");
    expect(samePeriod.cashFlow).toMatchObject({
      cfoMinor: "0",
      cfiMinor: "300",
      endingCashMinor: "300",
    });
    expect(samePeriod.nonCash.items).toEqual([]);

    const partial = run([
      ...sale.map((line) => ({ ...line, period: "opening" as const })),
      leg("cash", "asset", "cash", 120, 0, "collect"),
      leg("recv", "asset", "cfi", 0, 120, "collect", { accountCode: "asset_sale_receivable" }),
    ]);
    expect(partial.cashFlow.cfiMinor).toBe("120");
    expect(partial.nonCash.items).toEqual([]);
    const remainder = run([
      ...sale.map((line) => ({ ...line, period: "opening" as const })),
      leg("cash", "asset", "cash", 120, 0, "earlier", { period: "opening" }),
      leg("recv", "asset", "cfi", 0, 120, "earlier", {
        accountCode: "asset_sale_receivable",
        period: "opening",
      }),
      leg("cash", "asset", "cash", 180, 0, "rest"),
      leg("recv", "asset", "cfi", 0, 180, "rest", { accountCode: "asset_sale_receivable" }),
    ]);
    expect(remainder.cashFlow).toMatchObject({
      beginningCashMinor: "120",
      cfiMinor: "180",
      cfoMinor: "0",
      endingCashMinor: "300",
    });
    expect(remainder.nonCash.items).toEqual([]);
  });

  it("discloses assets bought with debt and capital expenditure on credit", () => {
    const loan = run([
      leg("fa", "asset", "cfi", 500, 0, "loan", { accountCode: "fixed_assets" }),
      leg("debt", "liability", "cff", 0, 500, "loan"),
    ]);
    expect(loan.cashFlow).toMatchObject({ cfiMinor: "0", cffMinor: "0" });
    expect(loan.nonCash.items).toEqual([
      expect.objectContaining({ type: "asset_acquired_with_debt", amountMinor: "500" }),
    ]);

    const opened = run([
      leg("fa", "asset", "cfi", 10000, 0, "open", {
        accountCode: "fixed_assets",
        journalKind: "opening",
      }),
      leg("debt", "liability", "cff", 0, 6000, "open", { journalKind: "opening" }),
      leg("equity", "equity", "cff", 0, 4000, "open", { journalKind: "opening" }),
    ]);
    expect(opened.nonCash.items).toEqual([]);

    const firstPeriod = run([
      leg("fa", "asset", "cfi", 10000, 0, "open", {
        accountCode: "fixed_assets",
        journalKind: "opening",
        period: "opening",
      }),
      leg("debt", "liability", "cff", 0, 6000, "open", {
        journalKind: "opening",
        period: "opening",
      }),
      leg("equity", "equity", "cff", 0, 4000, "open", {
        journalKind: "opening",
        period: "opening",
      }),
      leg("fa", "asset", "cfi", 500, 0, "buy", { accountCode: "fixed_assets" }),
      leg("debt", "liability", "cff", 0, 500, "buy"),
    ]);
    expect(firstPeriod.nonCash.items).toEqual([
      expect.objectContaining({ type: "asset_acquired_with_debt", amountMinor: "500" }),
    ]);
    const nextPeriod = run([
      leg("fa", "asset", "cfi", 10500, 0, "open", {
        accountCode: "fixed_assets",
        period: "opening",
      }),
      leg("debt", "liability", "cff", 0, 6500, "open", { period: "opening" }),
      leg("equity", "equity", "cff", 0, 4000, "open", { period: "opening" }),
    ]);
    expect(nextPeriod.nonCash.items).toEqual([]);

    const capex = run([
      leg("fa", "asset", "cfi", 400, 0, "capex", { accountCode: "fixed_assets" }),
      leg("pay", "liability", "cfi", 0, 400, "capex", { accountCode: "capex_payables" }),
    ]);
    expect(capex.nonCash.items).toEqual([
      expect.objectContaining({ type: "capex_on_credit", amountMinor: "400" }),
    ]);
    const paid = run([
      leg("fa", "asset", "cfi", 400, 0, "capex", { accountCode: "fixed_assets" }),
      leg("pay", "liability", "cfi", 0, 400, "capex", { accountCode: "capex_payables" }),
      leg("pay", "liability", "cfi", 400, 0, "pay", { accountCode: "capex_payables" }),
      leg("cash", "asset", "cash", 0, 400, "pay"),
    ]);
    expect(paid.cashFlow.cfiMinor).toBe("-400");
    expect(paid.nonCash.items).toEqual([]);
  });

  it("G38e does not treat a steady lease month as a new lease", () => {
    const steady = run(
      [
        leg("rou-dep", "expense", "non_cash", 200, 0, "dep", { accountCode: "depreciation_rou" }),
        leg("rou-accum", "asset", "non_cash", 0, 200, "dep", {
          accountCode: "rou_accumulated_depreciation",
        }),
        leg("interest", "expense", "cff", 60, 0, "pay", { accountCode: "interest_expense" }),
        leg("liab", "liability", "cff", 190, 0, "pay", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("cash", "asset", "cash", 0, 250, "pay"),
      ],
      { leaseAccounting: "ifrs16", interestPaid: "cfo" },
    );
    expect(steady.nonCash.leaseAdditionsMinor).toBe("0");
    expect(steady.cashFlow).toMatchObject({ cfoMinor: "-60", cfiMinor: "0", cffMinor: "-190" });
    expect(steady.issues).toEqual([]);
    expect(steady.notices).toEqual([]);

    const netOnly = run(
      [
        leg("rou-dep", "expense", "non_cash", 200, 0, "dep", { accountCode: "depreciation_rou" }),
        leg("rou", "asset", "non_cash", 0, 200, "dep", { accountCode: "rou_assets" }),
        leg("interest", "expense", "cff", 60, 0, "pay", { accountCode: "interest_expense" }),
        leg("liab", "liability", "cff", 190, 0, "pay", {
          accountCode: "lease_liabilities_noncurrent",
        }),
        leg("cash", "asset", "cash", 0, 250, "pay"),
      ],
      { leaseAccounting: "ifrs16", interestPaid: "cfo" },
    );
    expect(netOnly.nonCash.leaseAdditionsMinor).toBe("0");
    expect(netOnly.issues).toEqual([]);
    expect(netOnly.cashFlow).toMatchObject({ cfoMinor: "-60", cffMinor: "-190" });
  });

  it("raises a lease error when the liability rises with no right-of-use movement", () => {
    const accretion = [
      leg("interest", "expense", "cff", 10, 0, "acc", { accountCode: "interest_expense" }),
      leg("liab", "liability", "cff", 0, 10, "acc", {
        accountCode: "lease_liabilities_noncurrent",
      }),
    ];
    const passed = run(accretion);
    expect(passed.issues).toEqual([]);
    expect(passed.nonCash.leaseAdditionsMinor).toBe("0");
    expect(passed.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "0", cffMinor: "0" });

    expect(() =>
      run([
        leg("interest", "expense", "cff", 10, 0, "bank", { accountCode: "interest_expense" }),
        leg("cash", "asset", "cash", 0, 10, "bank"),
        leg("fa", "asset", "cfi", 10, 0, "lease", { accountCode: "fixed_assets" }),
        leg("liab", "liability", "cff", 0, 10, "lease", {
          accountCode: "lease_liabilities_noncurrent",
        }),
      ]),
    ).toThrow(/lease_additions_needed/);

    expect(() =>
      run([
        leg("interest", "expense", "cff", 10, 0, "over", { accountCode: "interest_expense" }),
        leg("fa", "asset", "cfi", 5, 0, "over", { accountCode: "fixed_assets" }),
        leg("liab", "liability", "cff", 0, 15, "over", {
          accountCode: "lease_liabilities_noncurrent",
        }),
      ]),
    ).toThrow(/lease_additions_needed/);

    expect(() =>
      run([
        leg("fa", "asset", "cfi", 500, 0, "new", { accountCode: "fixed_assets" }),
        leg("liab", "liability", "cff", 0, 500, "new", {
          accountCode: "lease_liabilities_noncurrent",
        }),
      ]),
    ).toThrow(/lease_additions_needed/);

    const fx = run([
      leg("fx", "expense", "cfo", 20, 0, "fx", {
        accountCode: "exchange_gain_loss",
        sourceLabel: "Foreign exchange loss",
      }),
      leg("liab", "liability", "cff", 0, 20, "fx", {
        accountCode: "lease_liabilities_noncurrent",
      }),
    ]);
    expect(fx.issues).toEqual([]);
    expect(fx.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "0", cffMinor: "0" });

    const remeasured = run([
      leg("rou", "asset", "non_cash", 40, 0, "remeasure", { accountCode: "rou_assets" }),
      leg("liab", "liability", "cff", 0, 40, "remeasure", {
        accountCode: "lease_liabilities_noncurrent",
      }),
    ]);
    expect(remeasured.issues).toEqual([]);
    expect(remeasured.nonCash.leaseAdditionsMinor).toBe("40");
    expect(remeasured.cashFlow).toMatchObject({ cfiMinor: "0", cffMinor: "0" });
  });

  it("keeps a mid-year opening apart from prior retained earnings", () => {
    const lines = [
      leg("cash", "asset", "cash", 1000, 0, "open", { journalKind: "opening" }),
      leg("revenue", "revenue", "cfo", 0, 500, "open", {
        journalKind: "opening",
        accountCode: "revenue",
      }),
      leg("opex", "expense", "cfo", 200, 0, "open", { journalKind: "opening" }),
      leg("tax", "expense", "cfo", 60, 0, "open", {
        journalKind: "opening",
        accountCode: "tax_expense",
      }),
      leg("re", "equity", "non_cash", 0, 760, "open", { journalKind: "opening" }),
    ];
    const midYear = buildStatements({
      currency: "USD",
      retainedEarningsAccountId: "re",
      lines,
      fiscalYear: {
        openingDate: "2025-07-01",
        statementDate: "2025-07-31",
        yearEndMonth: 12,
        yearEndDay: 31,
      },
    });
    expect(midYear.beforeNexora).toEqual({
      revenueMinor: "500",
      expensesMinor: "260",
      netIncomeMinor: "240",
      profitBeforeTaxMinor: "300",
      taxExpenseMinor: "60",
    });
    expect(midYear.incomeStatement).toEqual({
      revenueMinor: "0",
      expensesMinor: "0",
      netIncomeMinor: "0",
    });
    expect(midYear.retainedEarnings).toMatchObject({
      openingMinor: "760",
      beforeNexoraMinor: "240",
      netIncomeMinor: "0",
      endingMinor: "1000",
    });
    expect(midYear.yearToDate).toMatchObject({
      netIncomeMinor: "240",
      profitBeforeTaxMinor: "300",
      taxExpenseMinor: "60",
    });
    expect(midYear.effectiveTax.effectiveTaxRate).toBe("0.200000");
    expect(midYear.cashFlow).toMatchObject({
      beginningCashMinor: "1000",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "1000",
    });
    expect(midYear.balanceSheet.assetsMinor).toBe(midYear.balanceSheet.equityMinor);

    const withLater = buildStatements({
      currency: "USD",
      retainedEarningsAccountId: "re",
      lines: [
        ...lines,
        leg("cash", "asset", "cash", 100, 0, "later"),
        leg("revenue", "revenue", "cfo", 0, 100, "later", { accountCode: "revenue" }),
      ],
      fiscalYear: {
        openingDate: "2025-07-01",
        statementDate: "2025-10-31",
        yearEndMonth: 12,
        yearEndDay: 31,
      },
    });
    expect(withLater.incomeStatement).toMatchObject({ revenueMinor: "100", netIncomeMinor: "100" });
    expect(withLater.beforeNexora?.netIncomeMinor).toBe("240");
    expect(withLater.retainedEarnings).toMatchObject({
      openingMinor: "760",
      beforeNexoraMinor: "240",
      netIncomeMinor: "100",
      endingMinor: "1100",
    });
    expect(withLater.effectiveTax).toMatchObject({
      profitBeforeTaxMinor: "400",
      taxExpenseMinor: "60",
      effectiveTaxRate: "0.150000",
    });
    expect(withLater.cashFlow).toMatchObject({ cfoMinor: "100", beginningCashMinor: "1000" });

    const yearStart = buildStatements({
      currency: "USD",
      retainedEarningsAccountId: "re",
      lines,
      fiscalYear: {
        openingDate: "2025-01-01",
        statementDate: "2025-01-31",
        yearEndMonth: 12,
        yearEndDay: 31,
      },
    });
    expect(yearStart.beforeNexora).toBeNull();
    expect(yearStart.incomeStatement.netIncomeMinor).toBe("0");
    expect(yearStart.retainedEarnings.openingMinor).toBe("1000");
    expect(yearStart.retainedEarnings.beforeNexoraMinor).toBe("0");
    expect(yearStart.cashFlow.cfoMinor).toBe("0");
  });

  it("G-H5b keeps each month to itself and shows before Nexora once", () => {
    const opening = [
      leg("cash", "asset", "cash", 1000, 0, "open", { journalKind: "opening" }),
      leg("revenue", "revenue", "cfo", 0, 500, "open", {
        journalKind: "opening",
        accountCode: "revenue",
      }),
      leg("opex", "expense", "cfo", 200, 0, "open", { journalKind: "opening" }),
      leg("tax", "expense", "cfo", 60, 0, "open", {
        journalKind: "opening",
        accountCode: "tax_expense",
      }),
      leg("re", "equity", "non_cash", 0, 760, "open", { journalKind: "opening" }),
    ];
    const july = [
      leg("cash", "asset", "cash", 100, 0, "july"),
      leg("revenue", "revenue", "cfo", 0, 100, "july", { accountCode: "revenue" }),
    ];
    const august = [
      leg("cash", "asset", "cash", 50, 0, "august"),
      leg("revenue", "revenue", "cfo", 0, 50, "august", { accountCode: "revenue" }),
    ];
    const fiscal = {
      openingDate: "2025-07-01",
      yearEndMonth: 12,
      yearEndDay: 31,
    };
    const julyStatement = buildStatements({
      currency: "USD",
      retainedEarningsAccountId: "re",
      lines: opening.concat(july),
      fiscalYear: { ...fiscal, statementDate: "2025-07-31" },
    });
    expect(julyStatement.incomeStatement).toMatchObject({
      revenueMinor: "100",
      netIncomeMinor: "100",
    });
    expect(julyStatement.beforeNexora).toMatchObject({
      revenueMinor: "500",
      netIncomeMinor: "240",
      profitBeforeTaxMinor: "300",
      taxExpenseMinor: "60",
    });
    expect(julyStatement.yearToDate).toMatchObject({
      netIncomeMinor: "340",
      profitBeforeTaxMinor: "400",
      taxExpenseMinor: "60",
    });
    expect(julyStatement.effectiveTax.effectiveTaxRate).toBe("0.150000");
    expect(julyStatement.retainedEarnings).toMatchObject({
      openingMinor: "760",
      beforeNexoraMinor: "240",
      netIncomeMinor: "100",
      endingMinor: "1100",
    });
    expect(julyStatement.balanceSheet.assetsMinor).toBe("1100");
    expect(julyStatement.cashFlow).toMatchObject({ cfoMinor: "100", cfiMinor: "0", cffMinor: "0" });

    const augustStatement = buildStatements({
      currency: "USD",
      retainedEarningsAccountId: "re",
      lines: opening.concat(
        july.map((line) => ({ ...line, period: "opening" as const, periodEnd: "2025-07-31" })),
        august,
      ),
      fiscalYear: { ...fiscal, statementDate: "2025-08-31" },
    });
    expect(augustStatement.incomeStatement).toMatchObject({
      revenueMinor: "50",
      netIncomeMinor: "50",
    });
    expect(augustStatement.beforeNexora).toMatchObject({
      revenueMinor: "500",
      netIncomeMinor: "240",
      profitBeforeTaxMinor: "300",
      taxExpenseMinor: "60",
    });
    expect(augustStatement.yearToDate).toMatchObject({
      netIncomeMinor: "390",
      profitBeforeTaxMinor: "450",
      taxExpenseMinor: "60",
    });
    expect(augustStatement.effectiveTax.effectiveTaxRate).toBe("0.133333");
    expect(augustStatement.retainedEarnings).toMatchObject({
      openingMinor: "860",
      beforeNexoraMinor: "240",
      netIncomeMinor: "50",
      endingMinor: "1150",
    });
    expect(augustStatement.balanceSheet.assetsMinor).toBe("1150");
    expect(augustStatement.balanceSheet.assetsMinor).toBe(augustStatement.balanceSheet.equityMinor);
    expect(augustStatement.cashFlow).toMatchObject({
      cfoMinor: "50",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "1150",
    });

    const december = buildStatements({
      currency: "USD",
      retainedEarningsAccountId: "re",
      lines: opening.concat(
        july.map((line) => ({ ...line, period: "opening" as const, periodEnd: "2025-07-31" })),
        august.map((line) => ({ ...line, period: "opening" as const, periodEnd: "2025-08-31" })),
      ),
      fiscalYear: { ...fiscal, statementDate: "2025-12-31" },
    });
    expect(december.incomeStatement).toMatchObject({ revenueMinor: "0", netIncomeMinor: "0" });
    expect(december.beforeNexora?.netIncomeMinor).toBe("240");
    expect(december.beforeNexora?.revenueMinor).toBe("500");
    expect(december.yearToDate).toMatchObject({
      netIncomeMinor: "390",
      profitBeforeTaxMinor: "450",
    });
    expect(december.retainedEarnings.endingMinor).toBe("1150");
    expect(december.cashFlow).toMatchObject({
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "1150",
    });
  });

  it("treats deferred tax and OCI in a movement journal as non-cash", () => {
    const combined = run([
      leg("cash", "asset", "cash", 80, 0, "month"),
      leg("tax", "expense", "cfo", 40, 0, "month", { accountCode: "tax_expense" }),
      leg("revenue", "revenue", "cfo", 0, 100, "month"),
      leg("dtl", "liability", "non_cash", 0, 20, "month", {
        accountCode: "deferred_tax_liability",
      }),
    ]);
    expect(combined.cashFlow).toMatchObject({
      cfoMinor: "80",
      cfiMinor: "0",
      endingCashMinor: "80",
    });
    expect(combined.incomeStatement.netIncomeMinor).toBe("60");

    const throughOci = run([
      leg("oci", "equity", "non_cash", 10, 0, "oci", { accountCode: "oci_reserves" }),
      leg("dtl", "liability", "non_cash", 0, 10, "oci", { accountCode: "deferred_tax_liability" }),
    ]);
    expect(throughOci.cashFlow).toMatchObject({ cfoMinor: "0", cfiMinor: "0", cffMinor: "0" });

    const revaluation = run([
      leg("fa", "asset", "cfi", 50, 0, "reval", { accountCode: "fixed_assets" }),
      leg("reserve", "equity", "non_cash", 0, 50, "reval", { accountCode: "revaluation_reserve" }),
    ]);
    expect(revaluation.cashFlow).toMatchObject({ cfiMinor: "0", cfoMinor: "0" });

    expect(() =>
      run([
        leg("cash", "asset", "cash", 10, 0, "bad"),
        leg("reserve", "equity", "non_cash", 0, 10, "bad", { accountCode: "hedge_reserve" }),
      ]),
    ).toThrow(/Cash classification needed/);
  });

  it("sends other non-current accounts to review and keeps current leftovers in operating", () => {
    const current = run([
      leg("cash", "asset", "cash", 40, 0, "wc"),
      leg("other", "asset", "cfo", 0, 40, "wc", { accountCode: "other_current_assets" }),
    ]);
    expect(current.cashFlow.cfoMinor).toBe("40");
    expect(current.notices.map((item) => item.code)).not.toContain("other_noncurrent_review");

    const parked = run([
      leg("other", "asset", "non_cash", 40, 0, "park", { accountCode: "other_noncurrent_assets" }),
      leg("equity", "equity", "cff", 0, 40, "park"),
    ]);
    expect(parked.cashFlow).toMatchObject({ cfiMinor: "0", cffMinor: "0" });
    expect(parked.issues).toEqual([
      expect.objectContaining({
        code: "other_noncurrent_review",
        severity: "error",
      }),
    ]);
    expect(parked.issues.map((item) => item.message).join(" ")).toMatch(
      /Map the line to a deposit or a loan given/,
    );
    expect(parked.notices).toEqual([]);

    const openBalance = run([
      leg("other", "asset", "non_cash", 40, 0, "open", {
        accountCode: "other_noncurrent_assets",
        journalKind: "opening",
        period: "opening",
      }),
      leg("equity", "equity", "cff", 0, 40, "open", {
        journalKind: "opening",
        period: "opening",
      }),
    ]);
    expect(openBalance.issues).toEqual([]);
    expect(openBalance.notices.map((item) => item.code)).toEqual(["other_noncurrent_review"]);

    expect(() =>
      run([
        leg("cash", "asset", "cash", 25, 0, "draw"),
        leg("other", "liability", "non_cash", 0, 25, "draw", {
          accountCode: "other_noncurrent_liabilities",
        }),
      ]),
    ).toThrow(/Map the line to a borrowing or a long-term provision/);
  });
});
