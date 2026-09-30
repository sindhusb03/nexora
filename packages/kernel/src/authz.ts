import { KernelError } from "./errors.js";

export const ROLES = ["platform_admin", "owner", "controller", "viewer", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "tenant.provision",
  "membership.grant",
  "entity.write",
  "account.write",
  "period.write",
  "period.close",
  "journal.post",
  "journal.reverse",
  "journal.read",
  "statement.read",
  "valuation.calculate",
  "valuation.publish",
  "audit.read",
  "state.write",
  "state.publish",
  "lineage.read",
  "fx.write",
  "consolidation.run",
  "model.write",
  "model.calculate",
  "scenario.write",
  "report.write",
  "report.publish",
  "capital.write",
  "import.write",
  "proposal.write",
  "deal.write",
] as const;
export type Action = (typeof ACTIONS)[number];

const GRANTS: Record<Action, readonly Role[]> = {
  "tenant.provision": ["platform_admin"],
  "membership.grant": ["owner"],
  "entity.write": ["owner", "controller"],
  "account.write": ["owner", "controller"],
  "period.write": ["owner", "controller"],
  "period.close": ["owner", "controller"],
  "journal.post": ["owner", "controller"],
  "journal.reverse": ["owner", "controller"],
  "journal.read": ["owner", "controller", "viewer", "auditor"],
  "statement.read": ["owner", "controller", "viewer", "auditor"],
  "valuation.calculate": ["owner", "controller"],
  "valuation.publish": ["owner", "controller"],
  "audit.read": ["owner", "controller", "auditor"],
  "state.write": ["owner", "controller"],
  "state.publish": ["owner", "controller"],
  "lineage.read": ["owner", "controller", "viewer", "auditor"],
  "fx.write": ["owner", "controller"],
  "consolidation.run": ["owner", "controller"],
  "model.write": ["owner", "controller"],
  "model.calculate": ["owner", "controller"],
  "scenario.write": ["owner", "controller"],
  "report.write": ["owner", "controller"],
  "report.publish": ["owner", "controller"],
  "capital.write": ["owner", "controller"],
  "import.write": ["owner", "controller"],
  "proposal.write": ["owner", "controller"],
  "deal.write": ["owner", "controller"],
};

/** Missing roles fail closed. The caller must pass roles loaded from membership, not from the client. */
export function authorize(roles: readonly Role[], action: Action): void {
  if (roles.length === 0 || !roles.some((role) => GRANTS[action].includes(role))) {
    throw new KernelError("AUTH_SCOPE_DENIED", `Actor lacks permission for ${action}`);
  }
}

export function assertSameRegion(homeRegion: string, requestRegion: string): void {
  if (homeRegion.length === 0 || homeRegion !== requestRegion) {
    throw new KernelError(
      "REGION_MISMATCH",
      "Request region does not match the tenant home region",
    );
  }
}

export function assertTenantActive(status: "active" | "suspended"): void {
  if (status !== "active") {
    throw new KernelError("TENANT_SUSPENDED", "Tenant is suspended");
  }
}
