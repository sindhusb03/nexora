import { KernelError } from "@nexora/kernel";
import { and, asc, eq } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import type { LedgerStore, WorkspaceRow, WorkspaceUpdate, WorkspaceWrite } from "./records.js";
import { legalEntity, membership, tenant } from "./schema.js";
import { tenantTx, writeAudit } from "./store.js";
import { workspaceRecord } from "./workspace-schema.js";

export function createWorkspaceStore(db: AppDatabase) {
  return {
    listWorkspaceEntityIds(tenantId: string): Promise<readonly string[]> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ id: legalEntity.legalEntityId })
          .from(legalEntity)
          .where(eq(legalEntity.tenantId, tenantId))
          .orderBy(asc(legalEntity.createdAt), asc(legalEntity.legalEntityId));
        return rows.map((row) => row.id);
      });
    },

    grantSupportAccess(input: Parameters<LedgerStore["grantSupportAccess"]>[0]) {
      return tenantTx(db, input.tenantId, async (tx) => {
        if (
          !Number.isFinite(Date.parse(input.expiresAt)) ||
          Date.parse(input.expiresAt) <= Date.now()
        ) {
          throw new RangeError("Support expiry must be in the future");
        }
        await tx.insert(membership).values({
          membershipId: input.membershipId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          role: "auditor",
          createdAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.membershipAudit);
        await tx.insert(workspaceRecord).values({
          workspaceRecordId: input.id,
          tenantId: input.tenantId,
          kind: "support",
          status: "active",
          payload: {
            ...input.payload,
            actorId: input.actorId,
            membershipId: input.membershipId,
            expiresAt: input.expiresAt,
          },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },

    insertWorkspaceRecord(input: WorkspaceWrite) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx.insert(workspaceRecord).values({
          workspaceRecordId: input.id,
          tenantId: input.tenantId,
          kind: input.kind,
          status: input.status,
          payload: input.payload,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });
        await writeAudit(tx, input.tenantId, input.audit);
        return { id: input.id };
      });
    },

    listWorkspaceRecords(tenantId: string, kind: string): Promise<readonly WorkspaceRow[]> {
      return tenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(workspaceRecord)
          .where(and(eq(workspaceRecord.tenantId, tenantId), eq(workspaceRecord.kind, kind)));
        return rows.map((row) => ({
          id: row.workspaceRecordId,
          kind: row.kind,
          status: row.status,
          payload: asPayload(row.payload),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
      });
    },

    updateWorkspaceRecord(input: WorkspaceUpdate) {
      return tenantTx(db, input.tenantId, async (tx) => {
        const changed = await tx
          .update(workspaceRecord)
          .set({ status: input.status, payload: input.payload, updatedAt: input.updatedAt })
          .where(
            and(
              eq(workspaceRecord.workspaceRecordId, input.id),
              eq(workspaceRecord.tenantId, input.tenantId),
              input.expectedStatus === undefined
                ? undefined
                : eq(workspaceRecord.status, input.expectedStatus),
            ),
          )
          .returning({ id: workspaceRecord.workspaceRecordId });
        if (input.expectedStatus !== undefined && changed.length === 0) {
          throw new KernelError("FIN_VERSION_CONFLICT", "Workspace record changed since review");
        }
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },

    setTenantStatus(input: {
      tenantId: string;
      status: "active" | "suspended";
      audit: WorkspaceWrite["audit"];
    }) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx
          .update(tenant)
          .set({ status: input.status })
          .where(eq(tenant.tenantId, input.tenantId));
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },

    deleteMembership(input: {
      tenantId: string;
      membershipId: string;
      audit: WorkspaceWrite["audit"];
    }) {
      return tenantTx(db, input.tenantId, async (tx) => {
        await tx
          .delete(membership)
          .where(
            and(
              eq(membership.membershipId, input.membershipId),
              eq(membership.tenantId, input.tenantId),
            ),
          );
        await writeAudit(tx, input.tenantId, input.audit);
      });
    },
  };
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
