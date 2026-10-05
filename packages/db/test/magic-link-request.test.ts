import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAuthStore } from "../src/auth-store.js";
import { runMigrations } from "../src/migrate.js";
import { schema } from "../src/schema.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("magic-link request transaction", () => {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  const store = createAuthStore(db);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  beforeAll(async () => {
    await runMigrations({
      async query(text, params) {
        return client.query(text, params);
      },
      async exec(text) {
        await client.exec(text);
      },
    });
    await client.query(
      `INSERT INTO auth_user (actor_id, password_hash, email, created_at, disabled)
       VALUES ('mail-user', 'unused', 'known@example.com', $1, false),
              ('disabled-user', 'unused', 'disabled@example.com', $1, true)`,
      [now],
    );
  });

  afterAll(async () => {
    await client.close();
  });

  async function request(email: string, eventId: string, tokenHash = email) {
    return store.requestMagicLink(
      {
        subjectHash: hash(email),
        email,
        tokenHash: hash(tokenHash),
        createdAt: now,
        expiresAt,
        eventId,
        requestId: email,
      },
      (current) => ({
        subjectHash: hash(email),
        failures: (current?.failures ?? 0) + 1,
        windowStartedAt: current?.windowStartedAt ?? now,
        lockedUntil: null,
      }),
    );
  }

  it.each([
    ["known@example.com", "mail-user"],
    ["unknown@example.com", null],
    ["disabled@example.com", null],
  ])("uses one transaction with lockout and audit effects for %s", async (email, actorId) => {
    const transaction = vi.spyOn(db, "transaction");
    try {
      expect(await request(email, crypto.randomUUID())).toBe(actorId);
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      transaction.mockRestore();
    }
    expect(await store.readLockout(hash(email))).toEqual({
      subjectHash: hash(email),
      failures: 1,
      windowStartedAt: now,
      lockedUntil: null,
    });
    const audit = await client.query(
      "SELECT actor_id, tenant_id, event_type, outcome, payload FROM auth_audit_event WHERE request_id = $1",
      [email],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: actorId,
        tenant_id: null,
        event_type: "magic_link_sent",
        outcome: actorId ? "success" : "failure",
        payload: {},
      },
    ]);
    const links = await client.query("SELECT * FROM auth_magic_link WHERE token_hash = $1", [
      hash(email),
    ]);
    expect(links.rows).toHaveLength(actorId ? 1 : 0);
    if (actorId) {
      expect(await store.consumeMagicLink(hash(email), now)).toBe(actorId);
      expect(await store.consumeMagicLink(hash(email), now)).toBeNull();
    }
  });

  it("rolls back the link and lockout update when the audit insert fails", async () => {
    const email = "known@example.com";
    const before = await store.readLockout(hash(email));
    const auditBefore = await client.query<{ event_id: string }>("SELECT * FROM auth_audit_event");
    await expect(
      request(email, auditBefore.rows[0]!.event_id, "rolled-back-token"),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "auth_audit_event_pkey" } });
    expect(await store.readLockout(hash(email))).toEqual(before);
    expect(await store.consumeMagicLink(hash("rolled-back-token"), now)).toBeNull();
    expect((await client.query("SELECT * FROM auth_audit_event")).rows).toEqual(auditBefore.rows);
  });
});
