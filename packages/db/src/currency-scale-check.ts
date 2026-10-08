import { assertNoCurrencyScaleShift } from "@nexora/currency";
import pg from "pg";

/**
 * Distinct currencies on entities and journals. Run as a role that can see
 * every tenant. The API login cannot: row security would hide the rows and
 * the check would pass while stored amounts were still at risk.
 */
export const STORED_CURRENCY_SQL = `
  SELECT functional_currency AS currency FROM legal_entity
  UNION
  SELECT currency FROM journal_entry
`;

export function assertCurrencyScaleVisible(
  role: { readonly superuser: boolean; readonly bypassRls: boolean },
  currencies: readonly string[],
): void {
  if (!role.superuser && !role.bypassRls) {
    throw new Error(
      "Currency scale check cannot see every tenant. Connect with DATABASE_MIGRATION_URL as the schema owner (superuser or BYPASSRLS). Refusing to pass a partial check.",
    );
  }
  assertNoCurrencyScaleShift(currencies);
}

/** Fails the process when any stored entity or journal uses a rescaled currency. */
export async function assertStoredCurrencyScales(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const role = await client.query<{ superuser: boolean; bypass: boolean }>(
      "SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
    );
    const currencies = await client.query<{ currency: string }>(STORED_CURRENCY_SQL);
    const row = role.rows[0];
    assertCurrencyScaleVisible(
      { superuser: row?.superuser === true, bypassRls: row?.bypass === true },
      currencies.rows.map((item) => item.currency),
    );
  } finally {
    await client.end();
  }
}
