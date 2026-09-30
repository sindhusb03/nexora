import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const authUser = pgTable("auth_user", {
  actorId: text("actor_id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  disabled: boolean("disabled").notNull(),
});

/** Foreign keys to auth_user and tenant are declared in 0003_identity.sql. */
export const authSession = pgTable(
  "auth_session",
  {
    sessionId: uuid("session_id").primaryKey(),
    actorId: text("actor_id").notNull(),
    tenantId: uuid("tenant_id"),
    region: text("region").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [index("ix_auth_session_actor").on(table.actorId)],
);

export const identitySchema = { authUser, authSession };
