import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const workspaceRecord = pgTable("workspace_record", {
  workspaceRecordId: uuid("workspace_record_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
});
