import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { loadMigrationSql } from "../src/migration.js";
import { assertCurrencyScaleVisible, STORED_CURRENCY_SQL } from "../src/currency-scale-check.js";

describe("stored currency scale guard", () => {
  it("fails when the login cannot see every tenant", () => {
    expect(() => assertCurrencyScaleVisible({ superuser: false, bypassRls: false }, [])).toThrow(
      /cannot see every tenant/,
    );
  });

  it("fails when an entity or journal uses a currency whose scale changed", async () => {
    const db = new PGlite();
    await db.exec(loadMigrationSql());
    const tenant = "11111111-1111-4111-8111-111111111111";
    const entity = "22222222-2222-4222-8222-222222222222";
    const period = "33333333-3333-4333-8333-333333333333";
    const journal = "44444444-4444-4444-8444-444444444444";
    await db.exec("BEGIN");
    await db.query(
      `INSERT INTO tenant (tenant_id, name, home_region, status, created_at)
       VALUES ($1, 'Scale', 'us-east-1', 'active', now())`,
      [tenant],
    );
    await db.query(
      `INSERT INTO legal_entity (legal_entity_id, tenant_id, legal_name, functional_currency, created_at)
       VALUES ($1, $2, 'Scale Co', 'CLP', now())`,
      [entity, tenant],
    );
    await db.query(
      `INSERT INTO accounting_period (period_id, tenant_id, legal_entity_id, start_date, end_date, status, created_at)
       VALUES ($1, $2, $3, '2024-01-01', '2024-12-31', 'open', now())`,
      [period, tenant, entity],
    );
    await db.query(
      `INSERT INTO journal_entry (
         journal_id, tenant_id, legal_entity_id, period_id, status, currency,
         idempotency_key, payload_hash, actor_id, correlation_id, version, created_at, posted_at
       ) VALUES ($1, $2, $3, $4, 'draft', 'USD', 'key', 'hash', 'actor', 'corr', 1, now(), now())`,
      [journal, tenant, entity, period],
    );
    await db.exec("COMMIT");

    const found = await db.query<{ currency: string }>(STORED_CURRENCY_SQL);
    const codes = found.rows.map((row) => row.currency);
    expect(codes).toEqual(expect.arrayContaining(["CLP", "USD"]));
    expect(() => assertCurrencyScaleVisible({ superuser: true, bypassRls: false }, codes)).toThrow(
      /CLP/,
    );
    expect(() =>
      assertCurrencyScaleVisible({ superuser: true, bypassRls: false }, ["USD"]),
    ).not.toThrow();
  });
});
