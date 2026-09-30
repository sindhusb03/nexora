import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { createAuthStore } from "../src/auth-store.js";
import { drizzle } from "drizzle-orm/pglite";
import { runMigrations, type SqlExecutor } from "../src/migrate.js";
import { schema } from "../src/schema.js";

function executor(db: PGlite): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await db.query<R>(text, params);
      return { rows: result.rows };
    },
    async exec(text: string) {
      await db.exec(text);
    },
  };
}

describe("auth audit row-level security", () => {
  it("lets the actor read their events and hides another actor when tenant scope is off", async () => {
    const client = new PGlite();
    await runMigrations(executor(client));
    const db = drizzle({ client, schema });
    const auth = createAuthStore(db);
    const now = new Date().toISOString();
    await auth.insertAuthAudit({
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      eventType: "login_success",
      occurredAt: now,
      actorId: "owner-1",
      tenantId: "11111111-1111-4111-8111-111111111111",
      requestId: "req-owner",
      outcome: "success",
      payload: { method: "password" },
    });
    await auth.insertAuthAudit({
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      eventType: "login_failure",
      occurredAt: now,
      actorId: "viewer-1",
      tenantId: null,
      requestId: "req-viewer",
      outcome: "failure",
      payload: {},
    });

    const own = await auth.listAuthAudit({
      actorId: "owner-1",
      tenantId: null,
      includeTenant: false,
    });
    expect(own.map((event) => event.actorId)).toEqual(["owner-1"]);

    const other = await auth.listAuthAudit({
      actorId: "viewer-1",
      tenantId: "11111111-1111-4111-8111-111111111111",
      includeTenant: false,
    });
    expect(other.map((event) => event.eventType)).toEqual(["login_failure"]);

    const tenant = await auth.listAuthAudit({
      actorId: "viewer-1",
      tenantId: "11111111-1111-4111-8111-111111111111",
      includeTenant: true,
    });
    expect(tenant.map((event) => event.actorId).sort()).toEqual(["owner-1", "viewer-1"]);

    await client.exec("BEGIN");
    try {
      await client.exec("SET LOCAL ROLE nexora_app");
      await expect(
        client.query(
          `INSERT INTO auth_audit_event (event_id, event_type, occurred_at, actor_id, request_id, outcome, payload)
           VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'login_success', now(), 'owner-1', 'x', 'success', '{}')`,
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.exec("ROLLBACK");
    }
  });
});
