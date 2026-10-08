import { createPgliteFixture, createPgliteStore } from "@nexora/db";
import { describe, expect, it } from "vitest";

import { createDirectory } from "../src/workspace/directory.js";
import { call, testApp } from "./harness.js";

describe("workspace companies", () => {
  it("lists the actor's database companies when the in-memory directory is empty", async () => {
    const store = await createPgliteStore();
    const directory = createDirectory();
    const app = await testApp({ store, directory, demoMode: false });

    const harbor = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      body: { name: "Harbor Clinic LLC", homeRegion: "us-east-1", ownerActorId: "owner-a" },
    });
    expect(harbor.status).toBe(201);
    const atelier = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      body: { name: "Atelier Nord SAS", homeRegion: "us-east-1", ownerActorId: "owner-a" },
    });
    expect(atelier.status).toBe(201);
    const foreign = await call(app, "POST", "/v1/tenants", {
      actor: "owner-b",
      body: { name: "Other Books", homeRegion: "us-east-1", ownerActorId: "owner-b" },
    });
    expect(foreign.status).toBe(201);

    const listed = await call(app, "GET", "/v1/workspace/companies", { actor: "owner-a" });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      demoPasswordHint: string | null;
      companies: {
        name: string;
        region: string;
        status: string;
        entityId: string;
        periodId: string;
        support: boolean;
        members: { actorId: string; role: string }[];
      }[];
    };
    expect(directory.list()).toEqual([]);
    expect(body.demoPasswordHint).toBeNull();
    expect(body.companies.map((company) => company.name)).toEqual([
      "Atelier Nord SAS",
      "Harbor Clinic LLC",
    ]);
    expect(body.companies.every((company) => company.support === false)).toBe(true);
    expect(body.companies.every((company) => company.region === "us-east-1")).toBe(true);
    expect(body.companies[0]).toMatchObject({
      status: "active",
      entityId: "",
      periodId: "",
      members: [{ actorId: "owner-a", role: "owner" }],
    });

    const hidden = await call(app, "GET", "/v1/workspace/companies", { actor: "owner-b" });
    const other = (await hidden.json()) as { companies: { name: string }[] };
    expect(other.companies.map((company) => company.name)).toEqual(["Other Books"]);
  });

  it("returns 200 when the first-run route replays the same region", async () => {
    const store = await createPgliteStore();
    const listActorCompanies = store.listActorCompanies.bind(store);
    // The race itself runs on Postgres. Here the list stays empty so a second
    // request still takes the first-run route and the status mapping is visible.
    store.listActorCompanies = async (actorId) => {
      const companies = await listActorCompanies(actorId);
      return companies.length === 0 ? companies : [];
    };
    const app = await testApp({ store, directory: createDirectory(), demoMode: false });
    const created = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      body: { name: "Harbor Analytics", homeRegion: "us-east-1", ownerActorId: "owner-a" },
    });
    expect(created.status).toBe(201);
    const replay = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      body: { name: "harbor   analytics", homeRegion: "us-east-1", ownerActorId: "owner-a" },
    });
    expect(replay.status).toBe(200);
    const opened = (await created.json()) as { tenantId: string; replayed: boolean };
    const again = (await replay.json()) as { tenantId: string; name: string; replayed: boolean };
    expect(opened.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.tenantId).toBe(opened.tenantId);
    expect(again.name).toBe("Harbor Analytics");
    const events = await store.listAudit(opened.tenantId);
    expect(events.map((event) => event.eventType)).toContain("TenantProvisionReplayed");
    const companies = await listActorCompanies("owner-a");
    expect(companies).toEqual([
      expect.objectContaining({ tenantId: opened.tenantId, name: "Harbor Analytics" }),
    ]);
  });

  it("returns 409 when a first-run replay is for another region", async () => {
    const store = await createPgliteStore();
    const listActorCompanies = store.listActorCompanies.bind(store);
    store.listActorCompanies = async (actorId) => {
      const companies = await listActorCompanies(actorId);
      return companies.length === 0 ? companies : [];
    };
    const app = await testApp({ store, directory: createDirectory(), demoMode: false });
    const created = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      body: { name: "Harbor Analytics", homeRegion: "us-east-1", ownerActorId: "owner-a" },
    });
    expect(created.status).toBe(201);
    const conflict = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      region: "eu-west-1",
      body: { name: "Harbor Analytics", homeRegion: "eu-west-1", ownerActorId: "owner-a" },
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TENANT_REGION_CONFLICT");
    expect(await listActorCompanies("owner-a")).toHaveLength(1);
  });

  it("creates a new company when a platform admin provisions the same name", async () => {
    const app = await testApp({
      store: await createPgliteStore(),
      directory: createDirectory(),
      demoMode: false,
    });
    await call(app, "GET", "/v1/workspace/companies", { actor: "owner-a" });
    const body = { name: "Harbor Analytics", homeRegion: "us-east-1", ownerActorId: "owner-a" };
    const first = await call(app, "POST", "/v1/tenants", { actor: "platform-admin", body });
    const second = await call(app, "POST", "/v1/tenants", { actor: "platform-admin", body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const opened = (await first.json()) as { tenantId: string; replayed: boolean };
    const again = (await second.json()) as { tenantId: string; replayed: boolean };
    expect(opened.replayed).toBe(false);
    expect(again.replayed).toBe(false);
    expect(again.tenantId).not.toBe(opened.tenantId);
  });

  it("lets an owner who already has a company open a second one with the same name", async () => {
    const app = await testApp({
      store: await createPgliteStore(),
      directory: createDirectory(),
      demoMode: false,
    });
    const body = { name: "Harbor Analytics", homeRegion: "us-east-1", ownerActorId: "owner-a" };
    const first = await call(app, "POST", "/v1/tenants", { actor: "owner-a", body });
    expect(first.status).toBe(201);
    const second = await call(app, "POST", "/v1/tenants", { actor: "owner-a", body });
    expect(second.status).toBe(201);
    const opened = (await first.json()) as { tenantId: string; replayed: boolean };
    const again = (await second.json()) as { tenantId: string; replayed: boolean };
    expect(opened.replayed).toBe(false);
    expect(again.replayed).toBe(false);
    expect(again.tenantId).not.toBe(opened.tenantId);

    const listed = await call(app, "GET", "/v1/workspace/companies", { actor: "owner-a" });
    const companies = (await listed.json()) as { companies: { tenantId: string }[] };
    expect(companies.companies.map((company) => company.tenantId).sort()).toEqual(
      [opened.tenantId, again.tenantId].sort(),
    );
  });

  it("refuses a suspended seat when selecting a company", async () => {
    const { store, query } = await createPgliteFixture();
    const app = await testApp({ store, directory: createDirectory(), demoMode: false });
    const created = await call(app, "POST", "/v1/tenants", {
      actor: "owner-a",
      body: { name: "Paused Clinic", homeRegion: "us-east-1", ownerActorId: "owner-a" },
    });
    expect(created.status).toBe(201);
    const { tenantId } = (await created.json()) as { tenantId: string };
    await query(`UPDATE membership SET status = 'suspended' WHERE actor_id = $1`, ["owner-a"]);
    await expect(store.listRoles(tenantId, "owner-a")).resolves.toEqual([]);

    const selected = await call(app, "POST", "/auth/session/tenant", {
      actor: "owner-a",
      body: { tenantId },
    });
    expect(selected.status).toBe(403);
    const body = (await selected.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_SCOPE_DENIED");
  });
});
