import { loadMigrations, type Migration } from "./migration.js";

/** The subset of PGlite and node-postgres used by the runner. `exec` accepts several statements. */
export interface SqlExecutor {
  query<R extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
  exec(text: string): Promise<void>;
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly baselined: readonly string[];
}

export interface MigrationStatus {
  readonly pending: readonly string[];
  readonly drifted: readonly string[];
  readonly unknown: readonly string[];
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

const LOCK_KEY = 727_274_001;
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Tables whose presence shows a migration was applied before the runner existed. */
const BASELINE_MARKERS: Readonly<Record<string, string>> = {
  "0001_kernel_foundation.sql": "tenant",
  "0002_program.sql": "financial_state",
  "0003_identity.sql": "auth_user",
  "0004_workspace.sql": "workspace_record",
  "0005_auth_hosting.sql": "auth_audit_event",
};

export async function runMigrations(
  db: SqlExecutor,
  options: {
    readonly baseline?: boolean;
    readonly lock?: boolean;
    readonly apiLoginRole?: string | null;
  } = {},
): Promise<MigrationReport> {
  const migrations = loadMigrations();
  if (options.lock) {
    await db.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  }
  try {
    const baselined = (await tableExists(db, "schema_migrations"))
      ? []
      : await baseline(db, migrations, options.baseline ?? false);
    const applied = await appliedRows(db);
    assertKnown(migrations, applied);

    const newlyApplied: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.name);
      if (existing !== undefined) {
        if (existing !== migration.checksum) {
          throw new MigrationError(
            `${migration.name} was applied with a different checksum. Applied migrations are immutable; add a new migration instead.`,
          );
        }
        skipped.push(migration.name);
        continue;
      }
      await inTransaction(db, async () => {
        await db.exec(migration.sql);
        await db.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          migration.name,
          migration.checksum,
        ]);
      });
      newlyApplied.push(migration.name);
    }

    await db.exec("GRANT SELECT ON schema_migrations TO nexora_app");
    if (options.apiLoginRole) {
      await grantApiLogin(db, options.apiLoginRole);
    }
    return {
      applied: newlyApplied,
      skipped: skipped.filter((name) => !baselined.includes(name)),
      baselined,
    };
  } finally {
    if (options.lock) {
      await db.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  }
}

export async function migrationStatus(db: SqlExecutor): Promise<MigrationStatus> {
  const migrations = loadMigrations();
  if (!(await tableExists(db, "schema_migrations"))) {
    return { pending: migrations.map((migration) => migration.name), drifted: [], unknown: [] };
  }
  const applied = await appliedRows(db);
  const known = new Set(migrations.map((migration) => migration.name));
  return {
    pending: migrations
      .filter((migration) => !applied.has(migration.name))
      .map((migration) => migration.name),
    drifted: migrations
      .filter(
        (migration) =>
          applied.has(migration.name) && applied.get(migration.name) !== migration.checksum,
      )
      .map((migration) => migration.name),
    unknown: [...applied.keys()].filter((name) => !known.has(name)),
  };
}

async function baseline(
  db: SqlExecutor,
  migrations: readonly Migration[],
  allowed: boolean,
): Promise<string[]> {
  const present: Migration[] = [];
  for (const migration of migrations) {
    const marker = BASELINE_MARKERS[migration.name];
    if (marker && (await tableExists(db, marker))) {
      present.push(migration);
    }
  }
  if (present.length > 0 && !allowed) {
    throw new MigrationError(
      `The database already has kernel tables (${present.map((migration) => migration.name).join(", ")}) but no schema_migrations ledger. ` +
        "Confirm those files were applied unchanged, then re-run with --baseline to record them.",
    );
  }
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  for (const migration of present) {
    await db.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
      migration.name,
      migration.checksum,
    ]);
  }
  return present.map((migration) => migration.name);
}

async function appliedRows(db: SqlExecutor): Promise<Map<string, string>> {
  const result = await db.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations ORDER BY name",
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

function assertKnown(migrations: readonly Migration[], applied: ReadonlyMap<string, string>): void {
  const known = new Set(migrations.map((migration) => migration.name));
  const unknown = [...applied.keys()].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new MigrationError(
      `The database has migrations this build does not know: ${unknown.join(", ")}. Deploy the matching build.`,
    );
  }
}

async function tableExists(db: SqlExecutor, table: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`public.${table}`],
  );
  return result.rows[0]?.present === true;
}

async function inTransaction(db: SqlExecutor, fn: () => Promise<void>): Promise<void> {
  await db.exec("BEGIN");
  try {
    await fn();
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function grantApiLogin(db: SqlExecutor, role: string): Promise<void> {
  if (!ROLE_NAME.test(role)) {
    throw new MigrationError("The API login role name must be a lowercase Postgres identifier");
  }
  const result = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [role],
  );
  const row = result.rows[0];
  if (!row) {
    throw new MigrationError(
      `Login role ${role} does not exist. Create it first (see docs/operations.md).`,
    );
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new MigrationError(
      `Login role ${role} is a superuser or bypasses RLS. The API role must be subject to row-level security.`,
    );
  }
  await db.exec(`GRANT nexora_app TO ${role}`);
}
