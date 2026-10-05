import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import {
  authAuditEvent,
  authLockout,
  authMagicLink,
  authMfaChallenge,
  authOidcLink,
  authOidcState,
  authRecoveryCode,
  authSession,
  authTotp,
  authUser,
} from "./identity-schema.js";
import type { AuthAuditRecord, IdentityStore, LockoutRecord, SessionState } from "./records.js";

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

type AuthMethods = Pick<
  IdentityStore,
  | "sessionState"
  | "revokeSessionFamily"
  | "rotateSession"
  | "createMagicLink"
  | "createMagicLinkForEmail"
  | "requestMagicLink"
  | "consumeMagicLink"
  | "saveTotp"
  | "confirmTotp"
  | "acceptTotpStep"
  | "disableTotp"
  | "getTotp"
  | "saveRecoveryCodes"
  | "consumeRecoveryCode"
  | "readLockout"
  | "writeLockout"
  | "clearLockout"
  | "createMfaChallenge"
  | "readMfaChallenge"
  | "consumeMfaChallenge"
  | "insertAuthAudit"
  | "listAuthAudit"
  | "linkOidcAccount"
  | "findOidcLink"
  | "saveOidcState"
  | "consumeOidcState"
  | "appliedMigrations"
>;

export function createAuthStore(db: AppDatabase): AuthMethods {
  return {
    ...magicLinkMethods(db),
    requestMagicLink(input, updateLockout) {
      return authTx(db, async (tx) => {
        const scoped = magicLinkMethods(tx, (_db, work) => work(tx));
        const lockout = updateLockout(await scoped.readLockout(input.subjectHash));
        // One statement writes all three effects. The audit must succeed before commit.
        const inserted = await tx.execute(sql`
          WITH counted AS (
            INSERT INTO auth_lockout (subject_hash, failures, window_started_at, locked_until)
            VALUES (${input.subjectHash}, ${lockout.failures},
                    ${lockout.windowStartedAt}::timestamptz, ${lockout.lockedUntil}::timestamptz)
            ON CONFLICT (subject_hash) DO UPDATE
              SET failures = EXCLUDED.failures,
                  window_started_at = EXCLUDED.window_started_at,
                  locked_until = EXCLUDED.locked_until
            RETURNING subject_hash
          ), link AS (
            INSERT INTO auth_magic_link (token_hash, actor_id, created_at, expires_at)
            SELECT ${input.tokenHash}, actor_id, ${input.createdAt}::timestamptz,
                   ${input.expiresAt}::timestamptz
              FROM auth_user CROSS JOIN counted
             WHERE lower(email) = ${input.email} AND disabled = false
            RETURNING actor_id
          )
          INSERT INTO auth_audit_event
            (event_id, event_type, occurred_at, actor_id, tenant_id, request_id, outcome, payload)
          SELECT ${input.eventId}::uuid, 'magic_link_sent', ${new Date().toISOString()}::timestamptz,
                 (SELECT actor_id FROM link), NULL, ${input.requestId},
                 CASE WHEN EXISTS (SELECT 1 FROM link) THEN 'success' ELSE 'failure' END, '{}'::jsonb
          RETURNING actor_id
        `);
        const row = firstRow(inserted);
        const actorId = row?.actor_id ?? row?.actorId;
        return typeof actorId === "string" ? actorId : null;
      });
    },
    sessionState(sessionId) {
      return appTx(db, async (tx) => {
        const rows = await tx
          .select({
            state: sql<SessionState>`CASE
              WHEN ${authSession.revokedAt} IS NOT NULL THEN 'revoked'
              WHEN ${authSession.expiresAt} <= now() THEN 'expired'
              ELSE 'active'
            END`,
          })
          .from(authSession)
          .where(eq(authSession.sessionId, sessionId))
          .limit(1);
        return rows[0]?.state ?? "missing";
      });
    },

    revokeSessionFamily(sessionId, revokedAt) {
      return appTx(db, async (tx) => {
        await tx.execute(sql`
          UPDATE auth_session
             SET revoked_at = ${revokedAt}::timestamptz
           WHERE family_id = (SELECT family_id FROM auth_session WHERE session_id = ${sessionId}::uuid)
             AND revoked_at IS NULL
        `);
      });
    },

    rotateSession(input) {
      return appTx(db, async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO auth_session (
            session_id, actor_id, tenant_id, region, created_at, expires_at, family_id, rotated_from
          )
          SELECT ${input.nextSessionId}::uuid,
                 actor_id,
                 tenant_id,
                 region,
                 ${input.now}::timestamptz,
                 ${input.expiresAt}::timestamptz,
                 family_id,
                 session_id
            FROM auth_session
           WHERE session_id = ${input.sessionId}::uuid
             AND revoked_at IS NULL
             AND expires_at > now()
          RETURNING session_id
        `);
        if (rowCount(inserted) !== 1) return false;
        await tx
          .update(authSession)
          .set({ revokedAt: input.now })
          .where(and(eq(authSession.sessionId, input.sessionId), isNull(authSession.revokedAt)));
        return true;
      });
    },

    createMagicLink(input) {
      return authTx(db, async (tx) => {
        await tx.insert(authMagicLink).values(input);
      });
    },

    createMagicLinkForEmail(input) {
      return authTx(db, async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO auth_magic_link (token_hash, actor_id, created_at, expires_at)
          SELECT ${input.tokenHash}, actor_id, ${input.createdAt}::timestamptz, ${input.expiresAt}::timestamptz
            FROM auth_user
           WHERE lower(email) = ${input.email}
             AND disabled = false
          RETURNING actor_id
        `);
        const row = firstRow(inserted);
        const actorId = row?.actor_id ?? row?.actorId;
        return typeof actorId === "string" ? actorId : null;
      });
    },

    consumeMagicLink(tokenHash, usedAt) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authMagicLink)
          .set({ usedAt })
          .where(
            and(
              eq(authMagicLink.tokenHash, tokenHash),
              isNull(authMagicLink.usedAt),
              sql`${authMagicLink.expiresAt} > now()`,
            ),
          )
          .returning({ actorId: authMagicLink.actorId });
        return rows[0]?.actorId ?? null;
      });
    },

    saveTotp(input) {
      return authTx(db, async (tx) => {
        const existing = await tx
          .select({ enabledAt: authTotp.enabledAt })
          .from(authTotp)
          .where(eq(authTotp.actorId, input.actorId))
          .limit(1);
        const row = existing[0];
        if (!row) {
          await tx.insert(authTotp).values({
            actorId: input.actorId,
            secretCipher: input.secretCipher,
            createdAt: input.createdAt,
            enabledAt: null,
          });
          return "saved";
        }
        if (row.enabledAt !== null) return "locked";
        await tx
          .update(authTotp)
          .set({ secretCipher: input.secretCipher })
          .where(eq(authTotp.actorId, input.actorId));
        return "saved";
      });
    },

    acceptTotpStep(actorId, step) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authTotp)
          .set({ lastAcceptedStep: step })
          .where(
            and(
              eq(authTotp.actorId, actorId),
              sql`${authTotp.enabledAt} IS NOT NULL`,
              or(isNull(authTotp.lastAcceptedStep), lt(authTotp.lastAcceptedStep, step)),
            ),
          )
          .returning({ actorId: authTotp.actorId });
        return rows.length === 1;
      });
    },

    disableTotp(actorId, retiredAt) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authTotp)
          .set({ enabledAt: null, secretCipher: "retired", lastAcceptedStep: null })
          .where(and(eq(authTotp.actorId, actorId), sql`${authTotp.enabledAt} IS NOT NULL`))
          .returning({ actorId: authTotp.actorId });
        if (rows.length !== 1) return false;
        await tx
          .update(authRecoveryCode)
          .set({ usedAt: retiredAt })
          .where(and(eq(authRecoveryCode.actorId, actorId), isNull(authRecoveryCode.usedAt)));
        return true;
      });
    },

    confirmTotp(actorId, enabledAt) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authTotp)
          .set({ enabledAt })
          .where(and(eq(authTotp.actorId, actorId), isNull(authTotp.enabledAt)))
          .returning({ actorId: authTotp.actorId });
        return rows.length === 1;
      });
    },

    getTotp(actorId) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .select({ secretCipher: authTotp.secretCipher, enabledAt: authTotp.enabledAt })
          .from(authTotp)
          .where(eq(authTotp.actorId, actorId))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return { secretCipher: row.secretCipher, enabled: row.enabledAt !== null };
      });
    },

    saveRecoveryCodes(actorId, codeHashes) {
      return authTx(db, async (tx) => {
        if (codeHashes.length === 0) return;
        await tx.insert(authRecoveryCode).values(
          codeHashes.map((codeHash) => ({
            actorId,
            codeHash,
            usedAt: null,
          })),
        );
      });
    },

    consumeRecoveryCode(actorId, codeHash, usedAt) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authRecoveryCode)
          .set({ usedAt })
          .where(
            and(
              eq(authRecoveryCode.actorId, actorId),
              eq(authRecoveryCode.codeHash, codeHash),
              isNull(authRecoveryCode.usedAt),
            ),
          )
          .returning({ codeHash: authRecoveryCode.codeHash });
        return rows.length === 1;
      });
    },

    writeLockout(record) {
      return authTx(db, async (tx) => {
        await tx
          .insert(authLockout)
          .values(record)
          .onConflictDoUpdate({
            target: authLockout.subjectHash,
            set: {
              failures: record.failures,
              windowStartedAt: record.windowStartedAt,
              lockedUntil: record.lockedUntil,
            },
          });
      });
    },

    clearLockout(subjectHash) {
      return authTx(db, async (tx) => {
        await tx
          .update(authLockout)
          .set({ failures: 0, lockedUntil: null })
          .where(eq(authLockout.subjectHash, subjectHash));
      });
    },

    createMfaChallenge(input) {
      return authTx(db, async (tx) => {
        await tx.insert(authMfaChallenge).values({ ...input, usedAt: null });
      });
    },

    readMfaChallenge(challengeId) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .select({ actorId: authMfaChallenge.actorId, region: authMfaChallenge.region })
          .from(authMfaChallenge)
          .where(
            and(
              eq(authMfaChallenge.challengeId, challengeId),
              isNull(authMfaChallenge.usedAt),
              sql`${authMfaChallenge.expiresAt} > now()`,
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      });
    },

    consumeMfaChallenge(challengeId, usedAt) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authMfaChallenge)
          .set({ usedAt })
          .where(
            and(
              eq(authMfaChallenge.challengeId, challengeId),
              isNull(authMfaChallenge.usedAt),
              sql`${authMfaChallenge.expiresAt} > now()`,
            ),
          )
          .returning({ actorId: authMfaChallenge.actorId, region: authMfaChallenge.region });
        return rows[0] ?? null;
      });
    },

    insertAuthAudit(input) {
      return authTx(db, async (tx) => {
        await insertAudit(tx, input);
      });
    },

    listAuthAudit(input) {
      return db.transaction(async (tx) => {
        const scoped = tx as unknown as AppDatabase;
        await scoped.execute(sql.raw("SET LOCAL ROLE nexora_app"));
        await scoped.execute(sql`SELECT set_config('app.actor_id', ${input.actorId}, true)`);
        if (input.tenantId) {
          await scoped.execute(sql`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`);
        }
        if (input.includeTenant) {
          await scoped.execute(sql`SELECT set_config('app.auth_audit_tenant', 'on', true)`);
        }
        const rows = await scoped
          .select({
            eventId: authAuditEvent.eventId,
            eventType: authAuditEvent.eventType,
            occurredAt: sql<string>`to_char(${authAuditEvent.occurredAt} AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})`,
            actorId: authAuditEvent.actorId,
            tenantId: authAuditEvent.tenantId,
            requestId: authAuditEvent.requestId,
            outcome: authAuditEvent.outcome,
            payload: authAuditEvent.payload,
          })
          .from(authAuditEvent)
          .orderBy(desc(authAuditEvent.occurredAt))
          .limit(100);
        return rows.map((row) => ({
          eventId: row.eventId,
          eventType: row.eventType as AuthAuditRecord["eventType"],
          occurredAt: row.occurredAt,
          actorId: row.actorId,
          tenantId: row.tenantId,
          requestId: row.requestId,
          outcome: row.outcome === "failure" ? "failure" : "success",
          payload: row.payload,
        }));
      });
    },

    linkOidcAccount(input) {
      return authTx(db, async (tx) => {
        const actor = await tx
          .select({ actorId: authUser.actorId })
          .from(authUser)
          .where(eq(authUser.actorId, input.actorId))
          .limit(1);
        if (!actor[0]) return "missing_actor";
        try {
          await tx.insert(authOidcLink).values(input);
          return "linked";
        } catch (error) {
          if (isUniqueViolation(error)) return "conflict";
          throw error;
        }
      });
    },

    findOidcLink(issuer, subject) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .select({ actorId: authOidcLink.actorId })
          .from(authOidcLink)
          .where(and(eq(authOidcLink.issuer, issuer), eq(authOidcLink.subject, subject)))
          .limit(1);
        return rows[0] ?? null;
      });
    },

    saveOidcState(input) {
      return authTx(db, async (tx) => {
        await tx.insert(authOidcState).values({ ...input, usedAt: null });
      });
    },

    consumeOidcState(stateHash, usedAt) {
      return authTx(db, async (tx) => {
        const rows = await tx
          .update(authOidcState)
          .set({ usedAt })
          .where(
            and(
              eq(authOidcState.stateHash, stateHash),
              isNull(authOidcState.usedAt),
              sql`${authOidcState.expiresAt} > now()`,
            ),
          )
          .returning({
            providerId: authOidcState.providerId,
            nonceHash: authOidcState.nonceHash,
          });
        return rows[0] ?? null;
      });
    },

    appliedMigrations() {
      return appTx(db, async (tx) => {
        const result = await tx.execute(sql<{ name: string }>`SELECT name FROM schema_migrations`);
        return rowsOf(result).map((row) => row.name);
      });
    },
  };
}

export async function writeRoleChangeAudit(
  tx: AppDatabase,
  input: {
    readonly actorId: string;
    readonly tenantId: string;
    readonly role: string;
    readonly grantedBy: string;
    readonly requestId: string;
    readonly occurredAt: string;
  },
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.auth_maintenance', 'on', true)`);
  await insertAudit(tx, {
    eventId: crypto.randomUUID(),
    eventType: "role_change",
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    tenantId: input.tenantId,
    requestId: input.requestId,
    outcome: "success",
    payload: { role: input.role, grantedBy: input.grantedBy },
  });
}

async function insertAudit(
  tx: AppDatabase,
  input: {
    eventId: string;
    eventType: AuthAuditRecord["eventType"];
    occurredAt: string;
    actorId: string | null;
    tenantId: string | null;
    requestId: string;
    outcome: "success" | "failure";
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(authAuditEvent).values({
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    tenantId: input.tenantId,
    requestId: input.requestId,
    outcome: input.outcome,
    payload: input.payload,
  });
}

/** Reuse the lockout read inside the request transaction without nesting transactions. */
function magicLinkMethods(
  db: AppDatabase,
  transact: typeof authTx = authTx,
): Pick<IdentityStore, "readLockout"> {
  return {
    readLockout(subjectHash) {
      return transact(db, async (tx) => {
        const rows = await tx
          .select({
            subjectHash: authLockout.subjectHash,
            failures: authLockout.failures,
            windowStartedAt: sql<string>`to_char(${authLockout.windowStartedAt} AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})`,
            lockedUntil: sql<
              string | null
            >`to_char(${authLockout.lockedUntil} AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})`,
          })
          .from(authLockout)
          .where(eq(authLockout.subjectHash, subjectHash))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return {
          subjectHash: row.subjectHash,
          failures: row.failures,
          windowStartedAt: row.windowStartedAt,
          lockedUntil: row.lockedUntil,
        } satisfies LockoutRecord;
      });
    },
  };
}

export async function appTx<T>(db: AppDatabase, fn: (tx: AppDatabase) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE nexora_app"));
    return fn(tx as unknown as AppDatabase);
  });
}

async function authTx<T>(db: AppDatabase, fn: (tx: AppDatabase) => Promise<T>): Promise<T> {
  return appTx(db, async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_maintenance', 'on', true)`);
    return fn(tx);
  });
}

function isUniqueViolation(error: unknown): boolean {
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "object" && current !== null) {
      if ("code" in current && current.code === "23505") return true;
      if ("cause" in current) queue.push(current.cause);
    }
  }
  return false;
}

function rowCount(result: unknown): number {
  if (typeof result === "object" && result !== null && "rowCount" in result) {
    const count = (result as { rowCount: unknown }).rowCount;
    if (typeof count === "number") return count;
  }
  return rowsOf(result).length;
}

function firstRow(result: unknown): { actor_id?: string; actorId?: string } | null {
  if (Array.isArray(result)) {
    const row = result[0];
    return typeof row === "object" && row !== null
      ? (row as { actor_id?: string; actorId?: string })
      : null;
  }
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (!Array.isArray(rows)) return null;
    const row = rows[0];
    return typeof row === "object" && row !== null
      ? (row as { actor_id?: string; actorId?: string })
      : null;
  }
  return null;
}

function rowsOf(result: unknown): readonly { name: string }[] {
  if (Array.isArray(result)) return result as { name: string }[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? (rows as { name: string }[]) : [];
  }
  return [];
}
