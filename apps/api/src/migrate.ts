import { migratePostgres, MigrationError } from "@nexora/db";

import { errorFields, jsonLogger } from "./observability.js";

/**
 * Applies SQL migrations as the schema owner. Uses DATABASE_MIGRATION_URL when set so the API's
 * runtime login (DATABASE_URL) never needs DDL rights. Pass --baseline once for a database that
 * was migrated by hand before the schema_migrations ledger existed.
 */
const logger = jsonLogger();
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  logger.error("migrate.refused", { message: "Set DATABASE_MIGRATION_URL (schema owner) or DATABASE_URL." });
  process.exit(1);
}

try {
  const report = await migratePostgres(url, {
    baseline: process.argv.includes("--baseline"),
    apiLoginRole: process.env.NEXORA_API_LOGIN_ROLE?.trim() || null,
  });
  logger.info("migrate.completed", {
    applied: report.applied.join(",") || null,
    baselined: report.baselined.join(",") || null,
    alreadyApplied: report.skipped.length,
  });
} catch (error) {
  logger.error("migrate.failed", {
    ...errorFields(error),
    message: error instanceof MigrationError ? error.message : null,
  });
  process.exit(1);
}
