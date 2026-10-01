import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATION_NAMES = [
  "0001_kernel_foundation.sql",
  "0002_program.sql",
  "0003_identity.sql",
  "0004_workspace.sql",
  "0005_auth_hosting.sql",
  "0006_ingestion.sql",
  "0007_fiscal_year_end.sql",
] as const;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function loadMigrations(): readonly Migration[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  const migrations = join(directory, "../migrations");
  return MIGRATION_NAMES.map((name) => {
    const sql = readFileSync(join(migrations, name), "utf8");
    return {
      name,
      sql,
      checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex"),
    };
  });
}

export function loadMigrationSql(): string {
  return loadMigrations()
    .map((migration) => migration.sql)
    .join("\n");
}
