import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import {
  MigrationError,
  migrationStatus,
  runMigrations,
  type SqlExecutor,
} from "../src/migrate.js";
import { loadMigrationSql, MIGRATION_NAMES } from "../src/migration.js";

function executor(db: PGlite): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await db.query<R>(text, params);
      return { rows: result.rows };
    },
    async exec(text: string) {
      await db.exec(text);
    },
  };
}

describe("migration runner", () => {
  it("applies 0001, 0002, and 0003 once and is a no-op on the second run", async () => {
    const db = new PGlite();
    const first = await runMigrations(executor(db));
    expect(first.applied).toEqual([...MIGRATION_NAMES]);
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(executor(db));
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([...MIGRATION_NAMES]);
    await expect(migrationStatus(executor(db))).resolves.toEqual({
      pending: [],
      drifted: [],
      unknown: [],
    });
  });

  it("refuses an applied migration whose checksum changed", async () => {
    const db = new PGlite();
    await runMigrations(executor(db));
    await db.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE name = $1", [
      "0002_program.sql",
    ]);
    await expect(runMigrations(executor(db))).rejects.toThrow(MigrationError);
    const status = await migrationStatus(executor(db));
    expect(status.drifted).toEqual(["0002_program.sql"]);
  });

  it("refuses a database that is ahead of this build", async () => {
    const db = new PGlite();
    await runMigrations(executor(db));
    await db.query(
      "INSERT INTO schema_migrations (name, checksum) VALUES ('9999_future.sql', 'x')",
    );
    await expect(runMigrations(executor(db))).rejects.toThrow(/does not know/);
  });

  it("requires an explicit baseline for a database migrated before the ledger existed", async () => {
    const db = new PGlite();
    await db.exec(loadMigrationSql());
    await expect(runMigrations(executor(db))).rejects.toThrow(/--baseline/);

    const report = await runMigrations(executor(db), { baseline: true });
    expect(report.baselined).toEqual([...MIGRATION_NAMES]);
    expect(report.applied).toEqual([]);
    await expect(runMigrations(executor(db))).resolves.toMatchObject({
      applied: [],
      baselined: [],
    });
  });
});

describe("identity tables", () => {
  it("lets the app role create users and sessions but not rewrite or delete them", async () => {
    const db = new PGlite();
    await runMigrations(executor(db));
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";

    await asApp(db, tenantId, (query) =>
      query(
        `INSERT INTO tenant (tenant_id, name, home_region, status, created_at) VALUES ($1, 'A', 'us-east-1', 'active', now())`,
        [tenantId],
      ),
    );
    await asApp(db, null, async (query) => {
      await query(
        `INSERT INTO auth_user (actor_id, password_hash, created_at) VALUES ('owner-1', 'scrypt$x', now())`,
      );
      await query(
        `INSERT INTO auth_session (session_id, actor_id, region, created_at, expires_at)
         VALUES ($1, 'owner-1', 'us-east-1', now(), now() + interval '1 hour')`,
        [sessionId],
      );
      await query(`UPDATE auth_session SET tenant_id = $1 WHERE session_id = $2`, [
        tenantId,
        sessionId,
      ]);
    });

    await expect(
      asApp(db, null, (query) =>
        query(
          `INSERT INTO auth_user (actor_id, password_hash, created_at) VALUES ('Bad Name', 'x', now())`,
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asApp(db, null, (query) =>
        query(`UPDATE auth_user SET password_hash = 'swap' WHERE actor_id = 'owner-1'`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(db, null, (query) => query(`DELETE FROM auth_user WHERE actor_id = 'owner-1'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(db, null, (query) =>
        query(
          `UPDATE auth_session SET expires_at = now() + interval '30 days' WHERE session_id = $1`,
          [sessionId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(db, null, (query) =>
        query(`DELETE FROM auth_session WHERE session_id = $1`, [sessionId]),
      ),
    ).rejects.toThrow(/permission denied/);

    await asApp(db, null, (query) =>
      query(`UPDATE auth_session SET revoked_at = now() WHERE session_id = $1`, [sessionId]),
    );
    await expect(
      asApp(db, null, (query) =>
        query(`UPDATE auth_session SET tenant_id = NULL WHERE session_id = $1`, [sessionId]),
      ),
    ).rejects.toThrow(/AUTH_SESSION_REVOKED/);
    await expect(
      db.query(`DELETE FROM auth_session WHERE session_id = $1`, [sessionId]),
    ).rejects.toThrow(/FIN_IMMUTABLE_RECORD/);
  });
});

async function asApp<T>(
  db: PGlite,
  tenantId: string | null,
  fn: (
    query: <R extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: R[] }>,
  ) => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE nexora_app");
    if (tenantId) {
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }
    const result = await fn((text, params) => db.query(text, params));
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
