import { and, eq, isNull, sql } from "drizzle-orm";

import { appTx, createAuthStore } from "./auth-store.js";
import type { AppDatabase } from "./client.js";
import { authSession, authUser } from "./identity-schema.js";
import type { AuthUserRecord, IdentityStore } from "./records.js";
import { isUniqueViolation } from "./store.js";

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export function createIdentityStore(db: AppDatabase): IdentityStore {
  return {
    async createUser(input) {
      try {
        await appTx(db, async (tx) => {
          await tx.insert(authUser).values({
            actorId: input.actorId,
            passwordHash: input.passwordHash,
            email: input.email ?? null,
            createdAt: input.createdAt,
            disabled: false,
          });
        });
        return "created";
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await appTx(db, (tx) => readUser(tx, input.actorId));
          return existing ? "exists" : "email_taken";
        }
        throw error;
      }
    },

    findUser(actorId) {
      return appTx(db, (tx) => readUser(tx, actorId));
    },

    findUserByEmail(email) {
      return appTx(db, async (tx) => {
        const rows = await tx
          .select({ actorId: authUser.actorId })
          .from(authUser)
          .where(sql`lower(${authUser.email}) = ${email}`)
          .limit(1);
        const actorId = rows[0]?.actorId;
        return actorId ? readUser(tx, actorId) : null;
      });
    },

    createSession(input) {
      return appTx(db, async (tx) => {
        await tx.insert(authSession).values({
          sessionId: input.sessionId,
          actorId: input.actorId,
          tenantId: input.tenantId ?? null,
          region: input.region,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          revokedAt: null,
          familyId: input.familyId ?? crypto.randomUUID(),
          ...(input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {}),
        });
      });
    },

    getActiveSession(sessionId) {
      return appTx(db, async (tx) => {
        const rows = await tx
          .select({
            sessionId: authSession.sessionId,
            actorId: authSession.actorId,
            tenantId: authSession.tenantId,
            region: authSession.region,
            expiresAt: sql<string>`to_char(${authSession.expiresAt} AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})`,
          })
          .from(authSession)
          .innerJoin(authUser, eq(authUser.actorId, authSession.actorId))
          .where(
            and(
              eq(authSession.sessionId, sessionId),
              isNull(authSession.revokedAt),
              sql`${authSession.expiresAt} > now()`,
              eq(authUser.disabled, false),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      });
    },

    selectSessionTenant(sessionId, tenantId) {
      return appTx(db, async (tx) => {
        const rows = await tx
          .update(authSession)
          .set({ tenantId })
          .where(
            and(
              eq(authSession.sessionId, sessionId),
              isNull(authSession.revokedAt),
              sql`${authSession.expiresAt} > now()`,
            ),
          )
          .returning({ sessionId: authSession.sessionId });
        return rows.length === 1;
      });
    },

    revokeSession(sessionId, revokedAt) {
      return appTx(db, async (tx) => {
        await tx
          .update(authSession)
          .set({ revokedAt })
          .where(and(eq(authSession.sessionId, sessionId), isNull(authSession.revokedAt)));
      });
    },

    async ping() {
      await db.execute(sql`SELECT 1`);
    },

    ...createAuthStore(db),
  };
}

async function readUser(tx: AppDatabase, actorId: string): Promise<AuthUserRecord | null> {
  const rows = await tx
    .select({
      actorId: authUser.actorId,
      passwordHash: authUser.passwordHash,
      disabled: authUser.disabled,
      email: authUser.email,
    })
    .from(authUser)
    .where(eq(authUser.actorId, actorId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    actorId: row.actorId,
    passwordHash: row.passwordHash,
    disabled: row.disabled,
    email: row.email,
  };
}
