import { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { loadMigrationSql } from "../src/migration.js";
import { schema } from "../src/schema.js";

describe("kernel database contract", () => {
  it("hides other tenants, freezes posted journals, and rejects unbalanced posts", async () => {
    const db = new PGlite();
    await db.exec(loadMigrationSql());

    const tenantA = "11111111-1111-4111-8111-111111111111";
    const tenantB = "22222222-2222-4222-8222-222222222222";
    await asTenant(db, tenantA, async (query) => {
      await query(
        `INSERT INTO tenant (tenant_id, name, home_region, status, created_at)
         VALUES ($1, 'A', 'us-east-1', 'active', now())`,
        [tenantA],
      );
    });
    await asTenant(db, tenantB, async (query) => {
      await query(
        `INSERT INTO tenant (tenant_id, name, home_region, status, created_at)
         VALUES ($1, 'B', 'eu-central-1', 'active', now())`,
        [tenantB],
      );
    });

    const visible = await asTenant(db, tenantA, (query) => query<{ name: string }>("SELECT name FROM tenant"));
    expect(visible.rows.map((row) => row.name)).toEqual(["A"]);

    const entity = "33333333-3333-4333-8333-333333333333";
    const cash = "44444444-4444-4444-8444-444444444444";
    const revenue = "55555555-5555-4555-8555-555555555555";
    const period = "66666666-6666-4666-8666-666666666666";
    const journal = "77777777-7777-4777-8777-777777777777";
    await asTenant(db, tenantA, async (query) => {
      await query(
        `INSERT INTO legal_entity (legal_entity_id, tenant_id, legal_name, functional_currency, created_at)
         VALUES ($1, $2, 'A Co', 'USD', now())`,
        [entity, tenantA],
      );
      await query(
        `INSERT INTO account (account_id, tenant_id, legal_entity_id, code, name, report, cash_flow, currency, active, created_at)
         VALUES ($1, $2, $3, '1000', 'Cash', 'asset', 'cash', 'USD', true, now())`,
        [cash, tenantA, entity],
      );
      await query(
        `INSERT INTO account (account_id, tenant_id, legal_entity_id, code, name, report, cash_flow, currency, active, created_at)
         VALUES ($1, $2, $3, '4000', 'Revenue', 'revenue', 'cfo', 'USD', true, now())`,
        [revenue, tenantA, entity],
      );
      await query(
        `INSERT INTO accounting_period (period_id, tenant_id, legal_entity_id, start_date, end_date, status, created_at)
         VALUES ($1, $2, $3, '2024-01-01', '2024-12-31', 'open', now())`,
        [period, tenantA, entity],
      );
      await query(
        `INSERT INTO journal_entry (
           journal_id, tenant_id, legal_entity_id, period_id, status, currency, idempotency_key,
           payload_hash, actor_id, correlation_id, version, created_at
         ) VALUES ($1, $2, $3, $4, 'draft', 'USD', 'key-1', 'hash-1', 'owner', 'corr', 1, now())`,
        [journal, tenantA, entity, period],
      );
      await query(
        `INSERT INTO journal_line (journal_line_id, tenant_id, journal_id, account_id, line_no, debit_minor, credit_minor)
         VALUES ($1, $2, $3, $4, 1, 100, 0), ($5, $2, $3, $6, 2, 0, 100)`,
        [crypto.randomUUID(), tenantA, journal, cash, crypto.randomUUID(), revenue],
      );
      await query(
        `UPDATE journal_entry SET status = 'posted', posted_at = now() WHERE journal_id = $1`,
        [journal],
      );
    });

    await expect(
      asTenant(db, tenantA, (query) =>
        query(`UPDATE journal_entry SET source_ref = 'tamper' WHERE journal_id = $1`, [journal]),
      ),
    ).rejects.toThrow(/FIN_IMMUTABLE_RECORD/);

    await expect(
      asTenant(db, tenantA, (query) => query(`DELETE FROM journal_entry WHERE journal_id = $1`, [journal])),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query(`DELETE FROM journal_entry WHERE journal_id = $1`, [journal])).rejects.toThrow(
      /FIN_IMMUTABLE_RECORD/,
    );

    const unbalanced = crypto.randomUUID();
    await expect(
      asTenant(db, tenantA, async (query) => {
        await query(
          `INSERT INTO journal_entry (
             journal_id, tenant_id, legal_entity_id, period_id, status, currency, idempotency_key,
             payload_hash, actor_id, correlation_id, version, created_at
           ) VALUES ($1, $2, $3, $4, 'draft', 'USD', 'key-2', 'hash-2', 'owner', 'corr', 1, now())`,
          [unbalanced, tenantA, entity, period],
        );
        await query(
          `INSERT INTO journal_line (journal_line_id, tenant_id, journal_id, account_id, line_no, debit_minor, credit_minor)
           VALUES ($1, $2, $3, $4, 1, 100, 0), ($5, $2, $3, $6, 2, 0, 90)`,
          [crypto.randomUUID(), tenantA, unbalanced, cash, crypto.randomUUID(), revenue],
        );
        await query(`UPDATE journal_entry SET status = 'posted', posted_at = now() WHERE journal_id = $1`, [
          unbalanced,
        ]);
      }),
    ).rejects.toThrow(/FIN_UNBALANCED_JOURNAL/);

    const auditId = crypto.randomUUID();
    await asTenant(db, tenantA, (query) =>
      query(
        `INSERT INTO audit_event (
           event_id, event_type, event_version, tenant_id, occurred_at, actor_id,
           correlation_id, aggregate_type, aggregate_id, payload
         ) VALUES ($1, 'JournalPosted', 1, $2, now(), 'owner', 'corr', 'journal', $3, '{}'::jsonb)`,
        [auditId, tenantA, journal],
      ),
    );
    await expect(
      asTenant(db, tenantA, (query) =>
        query(`UPDATE audit_event SET actor_id = 'intruder' WHERE event_id = $1`, [auditId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(`UPDATE audit_event SET actor_id = 'intruder' WHERE event_id = $1`, [auditId]),
    ).rejects.toThrow(/FIN_IMMUTABLE_RECORD/);
  });

  it("creates every table declared by the Drizzle schema", async () => {
    const db = new PGlite();
    await db.exec(loadMigrationSql());
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const actual = result.rows.map((row) => row.table_name).sort();
    const expected = Object.values(schema).map((table) => getTableName(table)).sort();
    expect(actual).toEqual(expected);
  });
});

async function asTenant<T>(
  db: PGlite,
  tenantId: string,
  fn: (query: <R extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }>) => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE nexora_app");
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn((text, params) => db.query(text, params));
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
