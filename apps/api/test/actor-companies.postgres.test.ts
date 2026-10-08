import { openPostgres, type PostgresRuntime } from "@nexora/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDirectory } from "../src/workspace/directory.js";
import { call, testApp } from "./harness.js";

const databaseUrl =
  process.env.NEXORA_POSTGRES_RUNTIME === "1" ? process.env.DATABASE_URL : undefined;

describe.skipIf(!databaseUrl)("first-run replay on Postgres", () => {
  let runtime: PostgresRuntime;

  beforeAll(() => {
    runtime = openPostgres(databaseUrl!, { max: 8 });
  });

  afterAll(async () => {
    await runtime.close();
  });

  it("creates one company when two first-run requests race", async () => {
    const actorId = `race-${crypto.randomUUID()}`;
    const app = await testApp({
      store: runtime.store,
      directory: createDirectory(),
      demoMode: false,
    });
    await call(app, "GET", "/v1/workspace/companies", { actor: actorId });
    const [first, second] = await Promise.all([
      call(app, "POST", "/v1/tenants", {
        actor: actorId,
        body: { name: "Harbor Analytics", homeRegion: "us-east-1", ownerActorId: actorId },
      }),
      call(app, "POST", "/v1/tenants", {
        actor: actorId,
        body: { name: "harbor   analytics", homeRegion: "us-east-1", ownerActorId: actorId },
      }),
    ]);
    const responses = [first, second].sort((left, right) => left.status - right.status);
    expect(responses.map((response) => response.status)).toEqual([200, 201]);
    const replay = (await responses[0]!.json()) as { tenantId: string; replayed: boolean };
    const created = (await responses[1]!.json()) as { tenantId: string; replayed: boolean };
    expect(replay.replayed).toBe(true);
    expect(created.replayed).toBe(false);
    expect(replay.tenantId).toBe(created.tenantId);
    const listed = await call(app, "GET", "/v1/workspace/companies", { actor: actorId });
    const companies = (await listed.json()) as { companies: { tenantId: string }[] };
    expect(companies.companies.map((company) => company.tenantId)).toEqual([created.tenantId]);
  });

  it("returns 409 when a racing first-run uses another region", async () => {
    const actorId = `region-${crypto.randomUUID()}`;
    const app = await testApp({
      store: runtime.store,
      directory: createDirectory(),
      demoMode: false,
    });
    await call(app, "GET", "/v1/workspace/companies", { actor: actorId, region: "us-east-1" });
    await call(app, "GET", "/v1/workspace/companies", { actor: actorId, region: "eu-west-1" });
    const [east, west] = await Promise.all([
      call(app, "POST", "/v1/tenants", {
        actor: actorId,
        region: "us-east-1",
        body: { name: "Harbor Analytics", homeRegion: "us-east-1", ownerActorId: actorId },
      }),
      call(app, "POST", "/v1/tenants", {
        actor: actorId,
        region: "eu-west-1",
        body: { name: "Harbor Analytics", homeRegion: "eu-west-1", ownerActorId: actorId },
      }),
    ]);
    const responses = [east, west].sort((left, right) => left.status - right.status);
    expect(responses.map((response) => response.status)).toEqual([201, 409]);
    const conflict = (await responses[1]!.json()) as { error: { code: string } };
    expect(conflict.error.code).toBe("TENANT_REGION_CONFLICT");
    const listed = await call(app, "GET", "/v1/workspace/companies", {
      actor: actorId,
      region: "us-east-1",
    });
    const companies = (await listed.json()) as { companies: { region: string }[] };
    expect(companies.companies).toHaveLength(1);
  });
});
