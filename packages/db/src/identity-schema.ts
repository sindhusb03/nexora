import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const authUser = pgTable("auth_user", {
  actorId: text("actor_id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  email: text("email"),
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
    familyId: uuid("family_id").notNull(),
    rotatedFrom: uuid("rotated_from"),
  },
  (table) => [
    index("ix_auth_session_actor").on(table.actorId),
    index("ix_auth_session_family").on(table.familyId),
  ],
);

export const authAuditEvent = pgTable(
  "auth_audit_event",
  {
    eventId: uuid("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    actorId: text("actor_id"),
    tenantId: uuid("tenant_id"),
    requestId: text("request_id").notNull(),
    outcome: text("outcome").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    index("ix_auth_audit_actor").on(table.actorId, table.occurredAt),
    index("ix_auth_audit_tenant").on(table.tenantId, table.occurredAt),
  ],
);

export const authMagicLink = pgTable(
  "auth_magic_link",
  {
    tokenHash: text("token_hash").primaryKey(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [index("ix_auth_magic_actor").on(table.actorId)],
);

export const authTotp = pgTable("auth_totp", {
  actorId: text("actor_id").primaryKey(),
  secretCipher: text("secret_cipher").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true, mode: "string" }),
});

export const authRecoveryCode = pgTable("auth_recovery_code", {
  actorId: text("actor_id").notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
});

export const authLockout = pgTable("auth_lockout", {
  subjectHash: text("subject_hash").primaryKey(),
  failures: integer("failures").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "string" }),
});

export const authMfaChallenge = pgTable("auth_mfa_challenge", {
  challengeId: uuid("challenge_id").primaryKey(),
  actorId: text("actor_id").notNull(),
  region: text("region").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
});

export const authOidcLink = pgTable("auth_oidc_link", {
  linkId: uuid("link_id").primaryKey(),
  actorId: text("actor_id").notNull(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const authOidcState = pgTable("auth_oidc_state", {
  stateHash: text("state_hash").primaryKey(),
  providerId: text("provider_id").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
});

export const identitySchema = {
  authUser,
  authSession,
  authAuditEvent,
  authMagicLink,
  authTotp,
  authRecoveryCode,
  authLockout,
  authMfaChallenge,
  authOidcLink,
  authOidcState,
};
