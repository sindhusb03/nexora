import { assertStoredCurrencyScales } from "@nexora/db";

import { errorFields, jsonLogger } from "./observability.js";

/**
 * One-time cutover check. Run as the schema owner before relying on the
 * ISO 4217 scale. It records the cutover and looks only at rows created
 * before that instant. Migrations do not call it.
 *
 *   DATABASE_MIGRATION_URL=... pnpm --filter @nexora/api check:currency-scale
 */
const logger = jsonLogger();
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  logger.error("currency_scale.refused", {
    message: "Set DATABASE_MIGRATION_URL (schema owner) or DATABASE_URL.",
  });
  process.exit(1);
}

try {
  const record = await assertStoredCurrencyScales(url);
  logger.info("currency_scale.ok", {
    message: "No pre-cutover currency uses a scale that changed.",
    cutoverAt: record.cutoverAt,
    tableVersion: record.tableVersion,
    result: record.result,
    approver: record.approver,
  });
} catch (error) {
  logger.error("currency_scale.failed", {
    ...errorFields(error),
    message: error instanceof Error ? error.message : "Currency scale check failed",
  });
  process.exit(1);
}
