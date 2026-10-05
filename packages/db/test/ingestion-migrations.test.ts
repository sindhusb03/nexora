import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrationStatus, runMigrations, type SqlExecutor } from "../src/migrate.js";
import { loadMigrations, MIGRATION_NAMES } from "../src/migration.js";

function executor(db: PGlite): SqlExecutor {
  return {
    query: (sql, params) => db.query(sql, params),
    exec: async (sql) => {
      await db.exec(sql);
    },
  };
}
describe("ingestion migration integration", () => {
  it.each([0, 5, 6, 7])(
    "migrates a legacy database through %i and reports readiness",
    async (count) => {
      const db = new PGlite();
      try {
        for (const migration of loadMigrations().slice(0, count)) await db.exec(migration.sql);
        const report = await runMigrations(executor(db), { baseline: true });
        expect(report.baselined).toEqual(MIGRATION_NAMES.slice(0, count));
        expect(report.applied).toEqual(MIGRATION_NAMES.slice(count));
        expect(await migrationStatus(executor(db))).toEqual({
          pending: [],
          drifted: [],
          unknown: [],
        });
        expect((await runMigrations(executor(db))).applied).toEqual([]);
        const tables = [
          "ingestion_job",
          "source_document",
          "extracted_value",
          "ingestion_account_mapping",
          "ingestion_exception",
        ];
        const policies = await db.query<{ tablename: string; qual: string }>(
          "SELECT tablename, qual FROM pg_policies WHERE tablename = ANY($1)",
          [tables],
        );
        expect(policies.rows).toHaveLength(5);
        expect(
          policies.rows.every(
            (p) => p.qual.includes("app_tenant_id") && !p.qual.includes("app_auth_maintenance"),
          ),
        ).toBe(true);
        await db.exec(`INSERT INTO tenant VALUES ('11111111-1111-4111-8111-111111111111', 'Tenant', 'us-east-1', 'active', now());
        INSERT INTO legal_entity (legal_entity_id, tenant_id, legal_name, functional_currency) VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Entity', 'USD');
        INSERT INTO ingestion_job (ingestion_job_id, tenant_id, legal_entity_id, status, actor_id, created_at, updated_at) VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'queued', 'owner', now(), now());`);
        await db.exec("SET ROLE nexora_app; SET app.auth_maintenance = 'on'");
        for (const table of tables)
          expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
        await db.exec("SET app.tenant_id = '11111111-1111-4111-8111-111111111111'");
        expect((await db.query("SELECT * FROM ingestion_job")).rows).toHaveLength(1);
      } finally {
        await db.close();
      }
    },
  );
});
