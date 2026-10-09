import { assertNoCurrencyScaleShift } from "@nexora/currency";
import pg from "pg";

import {
  CURRENCY_SCALE_CUTOVER,
  type CurrencyScaleCutoverResult,
} from "./currency-scale-cutover.js";

/**
 * Currencies stored before the scale cutover. Later rows use the live table
 * and are outside this check, including CLP, ISK, UGX, IQD, LYD and TND.
 */
export const PRE_CUTOVER_CURRENCY_SQL = `
  SELECT functional_currency AS currency
  FROM legal_entity
  WHERE created_at < $1::timestamptz
  UNION
  SELECT currency
  FROM journal_entry
  WHERE created_at < $1::timestamptz
`;

export function assertCurrencyScaleVisible(
  role: { readonly superuser: boolean; readonly bypassRls: boolean },
  currencies: readonly string[],
): CurrencyScaleCutoverResult {
  if (!role.superuser && !role.bypassRls) {
    throw new Error(
      "Currency scale check cannot see every tenant. Connect with DATABASE_MIGRATION_URL as the schema owner (superuser or BYPASSRLS). Refusing to pass a partial check.",
    );
  }
  assertNoCurrencyScaleShift(currencies);
  return {
    cutoverAt: CURRENCY_SCALE_CUTOVER.cutoverAt,
    tableVersion: CURRENCY_SCALE_CUTOVER.tableVersion,
    result: CURRENCY_SCALE_CUTOVER.result,
    approver: CURRENCY_SCALE_CUTOVER.approver,
    shifted: [],
  };
}

/**
 * One-time check. Looks only at rows created before the recorded cutover.
 * The caller logs the returned record. A shifted pre-cutover currency throws.
 */
export async function assertStoredCurrencyScales(
  databaseUrl: string,
): Promise<CurrencyScaleCutoverResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const role = await client.query<{ superuser: boolean; bypass: boolean }>(
      "SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
    );
    const currencies = await client.query<{ currency: string }>(PRE_CUTOVER_CURRENCY_SQL, [
      CURRENCY_SCALE_CUTOVER.cutoverAt,
    ]);
    const row = role.rows[0];
    return assertCurrencyScaleVisible(
      { superuser: row?.superuser === true, bypassRls: row?.bypass === true },
      currencies.rows.map((item) => item.currency),
    );
  } finally {
    await client.end();
  }
}
