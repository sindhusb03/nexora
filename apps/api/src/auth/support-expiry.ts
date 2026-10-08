import type { LedgerStore } from "@nexora/db";

/** Run before entering tenant RLS scope, including when renewing a selected session. */
export async function enforceSupportExpiry(
  store: LedgerStore,
  tenantId: string,
  actorId: string,
  correlationId: string,
): Promise<"ok" | "expired"> {
  // The store API can filter by tenant and kind only. Never scan other tenants or kinds.
  const grants = (await store.listWorkspaceRecords(tenantId, "support")).filter(
    (grant) => grant.payload.actorId === actorId,
  );
  if (grants.length === 0) return "ok";
  const now = Date.now();
  const occurredAt = new Date(now).toISOString();
  let expired = false;
  for (const grant of grants) {
    if (grant.status !== "active") continue;
    const expiresAt =
      typeof grant.payload.expiresAt === "string" ? Date.parse(grant.payload.expiresAt) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt > now) continue;
    expired = true;
    const membershipId =
      typeof grant.payload.membershipId === "string" ? grant.payload.membershipId : "";
    // A corrupt membership reference must keep denying access until an operator repairs it.
    if (!membershipId) continue;
    await store.expireSupportGrant({
      tenantId,
      grantId: grant.id,
      membershipId,
      updatedAt: occurredAt,
      membershipAudit: {
        eventId: crypto.randomUUID(),
        eventType: "SupportExpired",
        aggregateType: "membership",
        aggregateId: membershipId,
        actorId,
        correlationId,
        occurredAt,
        payload: { tenantId },
      },
      grantAudit: {
        eventId: crypto.randomUUID(),
        eventType: "SupportExpired",
        aggregateType: "workspace_record",
        aggregateId: grant.id,
        actorId,
        correlationId,
        occurredAt,
        payload: {},
      },
    });
  }
  if (expired) return "expired";
  if (
    grants.some((grant) => grant.status === "expired") &&
    (await store.listRoles(tenantId, actorId)).length === 0
  ) {
    return "expired";
  }
  return "ok";
}
