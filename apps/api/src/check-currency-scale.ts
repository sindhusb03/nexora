import { assertStoredCurrencyScales } from "@nexora/db";

import { errorFields, jsonLogger } from "./observability.js";

/**
 * Pre-merge check. Run as the schema owner before deploying the ISO 4217 scale:
 *
 *   DATABASE_MIGRATION_URL=... pnpm --filter @nexora/api check:currency-scale
 *
 * Exits non-zero when an entity or journal uses a currency whose minor-unit
 * scale changed, or when the login cannot see every tenant.
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
  await assertStoredCurrencyScales(url);
  logger.info("currency_scale.ok", { message: "No stored currency uses a scale that changed." });
} catch (error) {
  logger.error("currency_scale.failed", {
    ...errorFields(error),
    message: error instanceof Error ? error.message : "Currency scale check failed",
  });
  process.exit(1);
}
