import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { runMigrations, type SqlExecutor } from "../src/migrate.js";
import type { AuditWrite } from "../src/records.js";
import { schema } from "../src/schema.js";
import { runWithRlsSession } from "../src/session-context.js";
import { createLedgerStore } from "../src/store.js";

/**
 * Visibility for migration 0008_actor_company_read.sql.
 * The actor-scoped SELECT policies are the method. There is no formula version:
 * the output is which rows nexora_app can read, not a money amount.
 * Inputs are membership status and whether app.tenant_id is set.
 */

const harbor = "11111111-1111-4111-8111-111111111111";
const paused = "22222222-2222-4222-8222-222222222222";
const departed = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";

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

function audit(tenantId: string, actorId: string): AuditWrite {
  return {
    eventId: crypto.randomUUID(),
    eventType: "TenantProvisioned",
    aggregateType: "tenant",
    aggregateId: tenantId,
    actorId,
    correlationId: "actor-companies",
    occurredAt: "2026-10-08T00:00:00.000Z",
    payload: {},
  };
}

async function asApp<T>(
  db: PGlite,
  actorId: string,
  tenantId: string | null,
  fn: (
    query: <R extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: R[] }>,
  ) => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE nexora_app");
    await db.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId ?? ""]);
    const result = await fn((text, params) => db.query(text, params));
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

describe("actor company visibility", () => {
  it("shows an actor only its active companies and leaves tenant scope unchanged", async () => {
    const client = new PGlite();
    await runMigrations(executor(client));
    const store = createLedgerStore(drizzle({ client, schema }));
    const seats = [
      { tenantId: harbor, name: "Harbor", actorId: "actor-a", membershipId: crypto.randomUUID() },
      { tenantId: paused, name: "Paused", actorId: "actor-a", membershipId: crypto.randomUUID() },
      {
        tenantId: departed,
        name: "Departed",
        actorId: "actor-a",
        membershipId: crypto.randomUUID(),
      },
      { tenantId: other, name: "Other", actorId: "actor-b", membershipId: crypto.randomUUID() },
    ] as const;
    for (const seat of seats) {
      await store.createTenant({
        tenant: {
          tenantId: seat.tenantId,
          name: seat.name,
          homeRegion: "us-east-1",
          status: "active",
          createdAt: "2026-10-08T00:00:00.000Z",
        },
        ownerActorId: seat.actorId,
        membershipId: seat.membershipId,
        audit: audit(seat.tenantId, seat.actorId),
      });
    }
    const leftOnHarbor = crypto.randomUUID();
    await store.grantMembership({
      tenantId: harbor,
      membershipId: leftOnHarbor,
      actorId: "actor-c",
      role: "viewer",
      audit: {
        ...audit(harbor, "actor-a"),
        eventId: crypto.randomUUID(),
        eventType: "MembershipGranted",
        aggregateType: "membership",
      },
    });
    await client.query(`UPDATE membership SET status = 'suspended' WHERE membership_id = $1`, [
      seats[1].membershipId,
    ]);
    await client.query(`UPDATE membership SET status = 'left' WHERE membership_id = $1`, [
      seats[2].membershipId,
    ]);
    await client.query(`UPDATE membership SET status = 'left' WHERE membership_id = $1`, [
      leftOnHarbor,
    ]);

    await expect(store.listActorCompanies("actor-a")).resolves.toEqual([
      expect.objectContaining({
        tenantId: harbor,
        name: "Harbor",
        members: [{ actorId: "actor-a", role: "owner" }],
      }),
    ]);
    await expect(store.listActorCompanies("actor-b")).resolves.toEqual([
      expect.objectContaining({ tenantId: other, name: "Other" }),
    ]);
    await expect(store.listActorCompanies("actor-c")).resolves.toEqual([]);
    await expect(store.listRoles(harbor, "actor-a")).resolves.toEqual(["owner"]);
    await expect(store.listRoles(harbor, "actor-c")).resolves.toEqual([]);
    await expect(store.listRoles(paused, "actor-a")).resolves.toEqual([]);
    await expect(
      runWithRlsSession({ actorId: "actor-b", tenantId: null }, () =>
        store.listActorCompanies("actor-a"),
      ),
    ).rejects.toThrow(/signed-in session/);
    await expect(store.getTenant(harbor)).resolves.toMatchObject({
      tenantId: harbor,
      name: "Harbor",
    });

    const actorRows = await asApp(client, "actor-a", null, (query) =>
      query<{ tenant_id: string; status: string }>(
        `SELECT tenant.tenant_id::text AS tenant_id, membership.status
           FROM membership
           JOIN tenant ON tenant.tenant_id = membership.tenant_id
          ORDER BY tenant.name`,
      ),
    );
    expect(actorRows.rows).toEqual([{ tenant_id: harbor, status: "active" }]);

    const otherActor = await asApp(client, "actor-b", null, (query) =>
      query<{ name: string }>(`SELECT name FROM tenant ORDER BY name`),
    );
    expect(otherActor.rows.map((row) => row.name)).toEqual(["Other"]);

    const tenantScoped = await asApp(client, "actor-a", harbor, (query) =>
      query<{ tenant_id: string; actor_id: string; status: string }>(
        `SELECT tenant.tenant_id::text AS tenant_id, membership.actor_id, membership.status
           FROM membership
           JOIN tenant ON tenant.tenant_id = membership.tenant_id
          ORDER BY membership.actor_id`,
      ),
    );
    expect(tenantScoped.rows).toEqual([
      { tenant_id: harbor, actor_id: "actor-a", status: "active" },
      { tenant_id: harbor, actor_id: "actor-c", status: "left" },
    ]);

    await expect(
      asApp(client, "actor-a", null, (query) =>
        query(
          `INSERT INTO tenant (tenant_id, name, home_region, status, created_at)
           VALUES ($1, 'Leak', 'us-east-1', 'active', now())`,
          ["55555555-5555-4555-8555-555555555555"],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied|new row violates/i);

    const updated = await asApp(client, "actor-a", null, (query) =>
      query<{ role: string }>(
        `UPDATE membership SET role = 'viewer' WHERE actor_id = 'actor-a' RETURNING role`,
      ),
    );
    expect(updated.rows).toEqual([]);
    const unchanged = await client.query<{ role: string }>(
      `SELECT role FROM membership WHERE membership_id = $1`,
      [seats[0].membershipId],
    );
    expect(unchanged.rows[0]?.role).toBe("owner");
  });

  it("inserts a second company when createTenant is called again with the same name", async () => {
    const client = new PGlite();
    await runMigrations(executor(client));
    const store = createLedgerStore(drizzle({ client, schema }));
    const first = await store.createTenant({
      tenant: {
        tenantId: harbor,
        name: "Harbor Analytics",
        homeRegion: "us-east-1",
        status: "active",
        createdAt: "2026-10-08T00:00:00.000Z",
      },
      ownerActorId: "actor-a",
      membershipId: crypto.randomUUID(),
      audit: audit(harbor, "actor-a"),
    });
    const second = await store.createTenant({
      tenant: {
        tenantId: other,
        name: "  HARBOR   analytics ",
        homeRegion: "eu-west-1",
        status: "active",
        createdAt: "2026-10-08T01:00:00.000Z",
      },
      ownerActorId: "actor-a",
      membershipId: crypto.randomUUID(),
      audit: audit(other, "actor-a"),
    });
    expect(first.tenantId).toBe(harbor);
    expect(second.tenantId).toBe(other);
    const companies = await store.listActorCompanies("actor-a");
    expect(companies.map((company) => company.tenantId).sort()).toEqual([harbor, other].sort());
  });

  it("replays a first-run open of the same name and records the replay", async () => {
    const client = new PGlite();
    await runMigrations(executor(client));
    const store = createLedgerStore(drizzle({ client, schema }));
    const opened = await store.openFirstCompany({
      tenant: {
        tenantId: harbor,
        name: "Harbor Analytics",
        homeRegion: "us-east-1",
        status: "active",
        createdAt: "2026-10-08T00:00:00.000Z",
      },
      ownerActorId: "actor-a",
      membershipId: crypto.randomUUID(),
      audit: audit(harbor, "actor-a"),
    });
    expect(opened).toEqual({
      tenant: expect.objectContaining({ tenantId: harbor, name: "Harbor Analytics" }),
      replayed: false,
    });
    const replay = await store.openFirstCompany({
      tenant: {
        tenantId: other,
        name: "  HARBOR   analytics ",
        homeRegion: "eu-west-1",
        status: "active",
        createdAt: "2026-10-08T01:00:00.000Z",
      },
      ownerActorId: "actor-a",
      membershipId: crypto.randomUUID(),
      audit: audit(other, "actor-a"),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.tenant.tenantId).toBe(harbor);
    expect(replay.tenant.homeRegion).toBe("us-east-1");
    const events = await store.listAudit(harbor);
    expect(events.map((event) => event.eventType)).toContain("TenantProvisionReplayed");
    await expect(store.listActorCompanies("actor-a")).resolves.toEqual([
      expect.objectContaining({ tenantId: harbor, name: "Harbor Analytics" }),
    ]);
  });
});
