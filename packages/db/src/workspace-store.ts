import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import type { AuditWrite, WorkspaceRow, WorkspaceUpdate, WorkspaceWrite } from "./records.js";
import { membership, tenant } from "./schema.js";
import { tenantTx, writeAudit } from "./store.js";
import { workspaceRecord } from "./workspace-schema.js";

export function createWorkspaceStore(db: AppDatabase) {
  return {
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
        await tx
          .update(workspaceRecord)
          .set({ status: input.status, payload: input.payload, updatedAt: input.updatedAt })
          .where(
            and(
              eq(workspaceRecord.workspaceRecordId, input.id),
              eq(workspaceRecord.tenantId, input.tenantId),
            ),
          );
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

    expireSupportGrant(input: {
      tenantId: string;
      grantId: string;
      membershipId: string;
      updatedAt: string;
      membershipAudit: AuditWrite;
      grantAudit: AuditWrite;
    }): Promise<boolean> {
      return tenantTx(db, input.tenantId, async (tx) => {
        const changed = await tx
          .update(workspaceRecord)
          .set({ status: "expired", updatedAt: input.updatedAt })
          .where(
            and(
              eq(workspaceRecord.workspaceRecordId, input.grantId),
              eq(workspaceRecord.tenantId, input.tenantId),
              eq(workspaceRecord.kind, "support"),
              eq(workspaceRecord.status, "active"),
            ),
          )
          .returning({ id: workspaceRecord.workspaceRecordId });
        if (changed.length === 0) return false;
        await tx
          .delete(membership)
          .where(
            and(
              eq(membership.membershipId, input.membershipId),
              eq(membership.tenantId, input.tenantId),
            ),
          );
        await writeAudit(tx, input.tenantId, input.membershipAudit);
        await writeAudit(tx, input.tenantId, input.grantAudit);
        return true;
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
