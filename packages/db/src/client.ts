import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import pg from "pg";

import { migrationStatus, runMigrations, type MigrationReport, type MigrationStatus, type SqlExecutor } from "./migrate.js";
import type { LedgerStore } from "./records.js";
import { schema } from "./schema.js";
import { createLedgerStore } from "./store.js";

export type AppDatabase = PgliteDatabase<typeof schema>;

/** Embedded Postgres for tests and local development. Every migration is applied through the runner. */
export async function createPgliteStore(): Promise<LedgerStore> {
  const client = new PGlite();
  await runMigrations(pgliteExecutor(client));
  const database = drizzle({ client, schema });
  return createLedgerStore(database);
}

export interface PostgresRuntimeReport {
  readonly loginRole: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** The login role owns kernel tables, so it could alter or disable row-level security. */
  readonly ownsKernelTables: boolean;
  readonly canUseAppRole: boolean;
  /** nexora_app exists, is not a superuser, and does not bypass RLS. */
  readonly appRoleSafe: boolean;
  readonly migrations: MigrationStatus;
}

export interface PostgresRuntime {
  readonly store: LedgerStore;
  inspect(): Promise<PostgresRuntimeReport>;
  close(): Promise<void>;
}

export function openPostgres(
  databaseUrl: string,
  options: { readonly max?: number; readonly statementTimeoutMs?: number; readonly onPoolError?: (error: Error) => void } = {},
): PostgresRuntime {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
  });
  pool.on("error", (error) => options.onPoolError?.(error));
  const database = drizzleNode(pool, { schema });
  return {
    store: createLedgerStore(database as unknown as AppDatabase),
    inspect: () => inspectPostgres(pool),
    close: () => pool.end(),
  };
}

export function createPostgresStore(databaseUrl: string): LedgerStore {
  return openPostgres(databaseUrl).store;
}

/** Applies pending migrations on one connection under an advisory lock. Run as the schema owner. */
export async function migratePostgres(
  databaseUrl: string,
  options: { readonly baseline?: boolean; readonly apiLoginRole?: string | null } = {},
): Promise<MigrationReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runMigrations(pgExecutor(client), { ...options, lock: true });
  } finally {
    await client.end();
  }
}

async function inspectPostgres(pool: pg.Pool): Promise<PostgresRuntimeReport> {
  const client = await pool.connect();
  try {
    const roles = await client.query<{
      login_role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns_tables: boolean;
      can_use_app: boolean;
      app_safe: boolean;
    }>(
      `SELECT current_user AS login_role,
              r.rolsuper,
              r.rolbypassrls,
              EXISTS (
                SELECT 1 FROM pg_tables
                 WHERE schemaname = 'public'
                   AND tablename IN ('journal_entry', 'tenant', 'audit_event')
                   AND tableowner = current_user
              ) AS owns_tables,
              COALESCE(
                (SELECT pg_has_role(current_user, oid, 'MEMBER') FROM pg_roles WHERE rolname = 'nexora_app'),
                false
              ) AS can_use_app,
              COALESCE(
                (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'nexora_app'),
                false
              ) AS app_safe
         FROM pg_roles r
        WHERE r.rolname = current_user`,
    );
    const row = roles.rows[0];
    if (!row) {
      throw new Error("Could not read the connected role from pg_roles");
    }
    let migrations: MigrationStatus;
    if (row.can_use_app) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE nexora_app");
        migrations = await migrationStatus(pgExecutor(client));
      } finally {
        await client.query("ROLLBACK");
      }
    } else {
      migrations = await migrationStatus(pgExecutor(client));
    }
    return {
      loginRole: row.login_role,
      superuser: row.rolsuper,
      bypassRls: row.rolbypassrls,
      ownsKernelTables: row.owns_tables,
      canUseAppRole: row.can_use_app,
      appRoleSafe: row.app_safe,
      migrations,
    };
  } finally {
    client.release();
  }
}

function pgliteExecutor(client: PGlite): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await client.query<R>(text, params);
      return { rows: result.rows };
    },
    async exec(text: string) {
      await client.exec(text);
    },
  };
}

function pgExecutor(client: pg.ClientBase): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await client.query<R>(text, params);
      return { rows: result.rows };
    },
    async exec(text: string) {
      await client.query(text);
    },
  };
}
