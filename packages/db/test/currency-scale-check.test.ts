import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { CURRENCY_SCALE_CUTOVER } from "../src/currency-scale-cutover.js";
import { loadMigrationSql } from "../src/migration.js";
import {
  assertCurrencyScaleVisible,
  PRE_CUTOVER_CURRENCY_SQL,
} from "../src/currency-scale-check.js";

describe("stored currency scale guard", () => {
  it("fails when the login cannot see every tenant", () => {
    expect(() => assertCurrencyScaleVisible({ superuser: false, bypassRls: false }, [])).toThrow(
      /cannot see every tenant/,
    );
  });

  it("checks only rows created before the cutover", async () => {
    const db = new PGlite();
    await db.exec(loadMigrationSql());
    const tenant = "11111111-1111-4111-8111-111111111111";
    const oldEntity = "22222222-2222-4222-8222-222222222222";
    const newEntity = "55555555-5555-4555-8555-555555555555";
    const period = "33333333-3333-4333-8333-333333333333";
    const journal = "44444444-4444-4444-8444-444444444444";
    await db.exec("BEGIN");
    await db.query(
      `INSERT INTO tenant (tenant_id, name, home_region, status, created_at)
       VALUES ($1, 'Scale', 'us-east-1', 'active', '2020-01-01')`,
      [tenant],
    );
    await db.query(
      `INSERT INTO legal_entity (legal_entity_id, tenant_id, legal_name, functional_currency, created_at)
       VALUES ($1, $2, 'Old Scale', 'CLP', '2020-01-01')`,
      [oldEntity, tenant],
    );
    await db.query(
      `INSERT INTO legal_entity (legal_entity_id, tenant_id, legal_name, functional_currency, created_at)
       VALUES ($1, $2, 'New Scale', 'IQD', '2026-10-09T00:00:00.000Z')`,
      [newEntity, tenant],
    );
    await db.query(
      `INSERT INTO accounting_period (period_id, tenant_id, legal_entity_id, start_date, end_date, status, created_at)
       VALUES ($1, $2, $3, '2024-01-01', '2024-12-31', 'open', '2020-01-01')`,
      [period, tenant, oldEntity],
    );
    await db.query(
      `INSERT INTO journal_entry (
         journal_id, tenant_id, legal_entity_id, period_id, status, currency,
         idempotency_key, payload_hash, actor_id, correlation_id, version, created_at, posted_at
       ) VALUES ($1, $2, $3, $4, 'draft', 'USD', 'key', 'hash', 'actor', 'corr', 1, '2026-11-01', '2026-11-01')`,
      [journal, tenant, oldEntity, period],
    );
    await db.exec("COMMIT");

    const found = await db.query<{ currency: string }>(PRE_CUTOVER_CURRENCY_SQL, [
      CURRENCY_SCALE_CUTOVER.cutoverAt,
    ]);
    const codes = found.rows.map((row) => row.currency);
    expect(codes).toEqual(["CLP"]);
    expect(codes).not.toEqual(expect.arrayContaining(["IQD"]));
    expect(CURRENCY_SCALE_CUTOVER).toMatchObject({
      tableVersion: "iso-4217",
      result: "clear",
      approver: "Sindhu Bharadwaj",
    });
    expect(() => assertCurrencyScaleVisible({ superuser: true, bypassRls: false }, codes)).toThrow(
      /CLP/,
    );
    expect(() =>
      assertCurrencyScaleVisible({ superuser: true, bypassRls: false }, ["USD"]),
    ).not.toThrow();
  });
});
