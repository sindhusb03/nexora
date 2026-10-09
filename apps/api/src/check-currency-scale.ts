import { assertStoredCurrencyScales } from "@nexora/db";

import { errorFields, jsonLogger } from "./observability.js";

/**
 * One-time scale check. Run as the schema owner at deploy, with no date
 * filter. The cutover time and the result are whatever this run outputs.
 * Attach that output to the release record. Migrations do not call it.
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
  const fields = {
    cutoverAt: record.cutoverAt,
    tableVersion: record.tableVersion,
    result: record.result,
    approver: record.approver,
    shifted: record.shifted.length === 0 ? "none" : record.shifted.join(","),
  };
  if (record.result !== "clear") {
    logger.error("currency_scale.refused", {
      message: "Stored currencies use a minor-unit scale that changed. Refusing the deploy.",
      ...fields,
    });
    process.exit(1);
  }
  logger.info("currency_scale.ok", {
    message: "No stored currency uses a scale that changed.",
    ...fields,
  });
} catch (error) {
  logger.error("currency_scale.failed", {
    ...errorFields(error),
    message: error instanceof Error ? error.message : "Currency scale check failed",
  });
  process.exit(1);
}
