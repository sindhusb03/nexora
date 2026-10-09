import {
  statementPolicyLabel,
  type LeaseAccounting,
  type StatementFinding,
  type StatementIssueCode,
  type StatementPolicy,
  type StatementSet,
} from "@nexora/kernel";

export interface PresentedFinding {
  readonly code: StatementIssueCode;
  readonly message: string;
  readonly action: string;
}

export interface PresentedPolicy {
  readonly label: string;
  readonly leaseAccounting: LeaseAccounting;
}

const ACTIONS: Record<StatementIssueCode, string> = {
  depreciation_split_needed:
    "Split the combined depreciation line into PP&E depreciation, right-of-use depreciation, and amortization.",
  lease_additions_needed:
    "Map right-of-use depreciation on its own account so new leases are not mistaken for payments.",
  disposal_gain_unmapped:
    "Map the gain or loss on disposal so the sale proceeds land in investing cash flow.",
  possible_non_cash_exchange:
    "Confirm the cash and non-cash parts, or split the exchange into its own journal.",
  asset_sale_in_trade_receivable: "Map the sale proceeds to an asset-sale receivable.",
  other_noncurrent_review:
    "Map the line to a deposit, a loan given, a borrowing, or a long-term provision.",
};

function presentFinding(finding: StatementFinding): PresentedFinding {
  return {
    code: finding.code,
    message: finding.message,
    action: ACTIONS[finding.code],
  };
}

export function presentStatementFindings(statement: StatementSet): {
  readonly issues: readonly PresentedFinding[];
  readonly notices: readonly PresentedFinding[];
} {
  return {
    issues: statement.issues.map(presentFinding),
    notices: statement.notices.map(presentFinding),
  };
}

export function presentStatementPolicy(policy: StatementPolicy): PresentedPolicy {
  const leaseAccounting = policy.leaseAccounting ?? "ifrs16";
  return { label: statementPolicyLabel(leaseAccounting), leaseAccounting };
}

const MISSING_RETAINED_EARNINGS = "This entity has no retained earnings account.";
const MISSING_RETAINED_EARNINGS_ACTION =
  "Set the retained earnings account, then close the period.";

const PLAIN_SENTENCES = [
  "We can't tell new leases apart from lease payments. Map right-of-use depreciation separately.",
  "Depreciation is posted as one combined amount. Split it so asset sales are read correctly.",
  "Cash in this journal needs a cash-flow class. Set the class on the account the cash settles.",
  "This journal moves cash without an offsetting account.",
  "Deferred tax is never settled with cash. Post the tax entry without a cash line.",
  "The cash flow does not roll forward to the ending cash balance. Review the cash-flow class on each account that moved.",
  "Other non-current assets are not a cash-flow account. Map the line to a deposit or a loan given.",
  "Other non-current liabilities are not a cash-flow account. Map the line to a borrowing or a long-term provision.",
  "We couldn't build this statement. Check the flagged accounts.",
  MISSING_RETAINED_EARNINGS,
];

/** User-facing text for a statement failure. Never a raw code or a journal id. */
export function plainStatementMessage(message: string): string {
  if (message.includes("no retained earnings account")) return MISSING_RETAINED_EARNINGS;
  if (PLAIN_SENTENCES.includes(message)) return message;
  const parts: string[] = [];
  if (message.includes("lease_additions_needed")) {
    parts.push(
      "We can't tell new leases apart from lease payments. Map right-of-use depreciation separately.",
    );
  }
  if (message.includes("depreciation_split_needed")) {
    parts.push(
      "Depreciation is posted as one combined amount. Split it so asset sales are read correctly.",
    );
  }
  if (message.includes("Cash classification needed")) {
    parts.push(
      "Cash in this journal needs a cash-flow class. Set the class on the account the cash settles.",
    );
  }
  if (message.includes("cash movement has no counterpart")) {
    parts.push("This journal moves cash without an offsetting account.");
  }
  if (message.includes("Deferred tax is never cash-settled")) {
    parts.push("Deferred tax is never settled with cash. Post the tax entry without a cash line.");
  }
  if (
    message.includes("does not roll forward") ||
    message.includes("Cash flow does not roll forward")
  ) {
    parts.push(
      "The cash flow does not roll forward to the ending cash balance. Review the cash-flow class on each account that moved.",
    );
  }
  if (message.includes("Other non-current assets are not a cash-flow account")) {
    parts.push(
      "Other non-current assets are not a cash-flow account. Map the line to a deposit or a loan given.",
    );
  }
  if (message.includes("Other non-current liabilities are not a cash-flow account")) {
    parts.push(
      "Other non-current liabilities are not a cash-flow account. Map the line to a borrowing or a long-term provision.",
    );
  }
  if (parts.length > 0) return parts.join(" ");
  return "We couldn't build this statement. Check the flagged accounts.";
}

/** One sentence and one action when a period cannot be closed. */
export function closeRefusal(message: string): {
  readonly message: string;
  readonly action: string;
} {
  if (message.includes("no retained earnings account")) {
    return { message: MISSING_RETAINED_EARNINGS, action: MISSING_RETAINED_EARNINGS_ACTION };
  }
  return {
    message: plainStatementMessage(message),
    action: "Fix the flagged accounts, then close the period.",
  };
}
