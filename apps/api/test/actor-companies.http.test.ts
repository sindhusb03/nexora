import { createPgliteStore } from "@nexora/db";
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
});
