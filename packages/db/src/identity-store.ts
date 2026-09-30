import { and, eq, isNull, sql } from "drizzle-orm";

import type { AppDatabase } from "./client.js";
import { authSession, authUser } from "./identity-schema.js";
import type { IdentityStore } from "./records.js";
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
            createdAt: input.createdAt,
            disabled: false,
          });
        });
        return "created";
      } catch (error) {
        if (isUniqueViolation(error)) {
          return "exists";
        }
        throw error;
      }
    },

    findUser(actorId) {
      return appTx(db, async (tx) => {
        const rows = await tx
          .select({ actorId: authUser.actorId, passwordHash: authUser.passwordHash, disabled: authUser.disabled })
          .from(authUser)
          .where(eq(authUser.actorId, actorId))
          .limit(1);
        return rows[0] ?? null;
      });
    },

    createSession(input) {
      return appTx(db, async (tx) => {
        await tx.insert(authSession).values({
          sessionId: input.sessionId,
          actorId: input.actorId,
          tenantId: null,
          region: input.region,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          revokedAt: null,
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
          .where(and(eq(authSession.sessionId, sessionId), isNull(authSession.revokedAt), sql`${authSession.expiresAt} > now()`))
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
  };
}

async function appTx<T>(db: AppDatabase, fn: (tx: AppDatabase) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE nexora_app"));
    return fn(tx as unknown as AppDatabase);
  });
}
