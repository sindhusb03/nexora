import { currencyScaleShifts } from "@nexora/currency";
import pg from "pg";

import {
  CURRENCY_SCALE_TABLE_VERSION,
  type CurrencyScaleCutoverResult,
} from "./currency-scale-cutover.js";

/**
 * Every stored currency. The deploy check uses this query, with no date filter.
 */
export const STORED_CURRENCY_SQL = `
  SELECT functional_currency AS currency
  FROM legal_entity
  UNION
  SELECT currency
  FROM journal_entry
`;

/**
 * Optional filter when a caller passes a cutover time. Rows created at or
 * after that time are left out. The deploy script does not pass one.
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
  cutoverAt: string,
): CurrencyScaleCutoverResult {
  if (!role.superuser && !role.bypassRls) {
    throw new Error(
      "Currency scale check cannot see every tenant. Connect with DATABASE_MIGRATION_URL as the schema owner (superuser or BYPASSRLS). Refusing to pass a partial check.",
    );
  }
  const shifted = currencyScaleShifts(currencies).map((shift) => shift.code);
  return {
    cutoverAt,
    tableVersion: CURRENCY_SCALE_TABLE_VERSION,
    result: shifted.length === 0 ? "clear" : "refused",
    approver: null,
    shifted,
  };
}

/**
 * One-time check. With no cutover time, every stored currency is in scope and
 * the recorded cutover is the time of this run. Migrations do not call it.
 * A shifted currency is returned as refused rather than written down as clear.
 */
export async function assertStoredCurrencyScales(
  databaseUrl: string,
  cutoverAt?: string,
): Promise<CurrencyScaleCutoverResult> {
  const recordedAt = cutoverAt ?? new Date().toISOString();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const role = await client.query<{ superuser: boolean; bypass: boolean }>(
      "SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
    );
    const currencies =
      cutoverAt === undefined
        ? await client.query<{ currency: string }>(STORED_CURRENCY_SQL)
        : await client.query<{ currency: string }>(PRE_CUTOVER_CURRENCY_SQL, [cutoverAt]);
    const row = role.rows[0];
    return assertCurrencyScaleVisible(
      { superuser: row?.superuser === true, bypassRls: row?.bypass === true },
      currencies.rows.map((item) => item.currency),
      recordedAt,
    );
  } finally {
    await client.end();
  }
}
