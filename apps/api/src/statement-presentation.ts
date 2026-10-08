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
    "Split the combined depreciation line into PP&E depreciation, right-of-use depreciation, and amortisation.",
  lease_additions_needed:
    "Map right-of-use depreciation on its own account so new leases are not mistaken for payments.",
  disposal_gain_unmapped:
    "Map the gain or loss on disposal so the sale proceeds land in investing cash flow.",
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

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

/** User-facing text for a statement failure. Never a raw code or a journal id. */
export function plainStatementMessage(message: string): string {
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
  if (parts.length > 0) return parts.join(" ");
  const stripped = message.replace(UUID, "").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : "The statement could not be built.";
}
