import type { StatementSet } from "@nexora/kernel";
import { describe, expect, it } from "vitest";

import {
  closeRefusal,
  plainStatementMessage,
  presentStatementFindings,
} from "../src/statement-presentation.js";

describe("statement sentences", () => {
  it("gives a missing retained-earnings account its own sentence and one action", () => {
    expect(plainStatementMessage("Entity has no retained earnings account")).toBe(
      "This entity has no retained earnings account.",
    );
    expect(closeRefusal("Entity has no retained earnings account")).toEqual({
      message: "This entity has no retained earnings account.",
      action: "Set the retained earnings account, then close the period.",
    });
    expect(closeRefusal("lease_additions_needed").action).toBe(
      "Fix the flagged accounts, then close the period.",
    );
  });

  it("points an other non-current line at a concrete account", () => {
    const presented = presentStatementFindings(statementWith("other_noncurrent_review"));
    expect(presented.issues).toEqual([
      {
        code: "other_noncurrent_review",
        message:
          "Other non-current assets are not a cash-flow account. Map the line to a deposit or a loan given.",
        action: "Map the line to a deposit, a loan given, a borrowing, or a long-term provision.",
      },
    ]);
  });
});

function statementWith(code: "other_noncurrent_review"): StatementSet {
  const zero = {
    revenueMinor: "0",
    expensesMinor: "0",
    netIncomeMinor: "0",
  };
  return {
    engineVersion: "fe-kernel-0.3.0",
    currency: "USD",
    inputHash: "hash",
    incomeStatement: zero,
    beforeNexora: null,
    yearToDate: { ...zero, profitBeforeTaxMinor: "0", taxExpenseMinor: "0" },
    effectiveTax: { profitBeforeTaxMinor: "0", taxExpenseMinor: "0", effectiveTaxRate: null },
    balanceSheet: { assetsMinor: "0", liabilitiesMinor: "0", equityMinor: "0" },
    cashFlow: {
      beginningCashMinor: "0",
      cfoMinor: "0",
      cfiMinor: "0",
      cffMinor: "0",
      endingCashMinor: "0",
    },
    retainedEarnings: {
      openingMinor: "0",
      beforeNexoraMinor: "0",
      netIncomeMinor: "0",
      distributionsMinor: "0",
      directEntriesMinor: "0",
      endingMinor: "0",
      close: "derived",
    },
    nonCash: { leaseAdditionsMinor: "0", items: [] },
    issues: [
      {
        code,
        severity: "error",
        sourceLabel: null,
        message:
          "Other non-current assets are not a cash-flow account. Map the line to a deposit or a loan given.",
      },
    ],
    notices: [],
  };
}
