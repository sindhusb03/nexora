import { createPgliteStore, type LedgerStore } from "@nexora/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp, DEFAULT_HTTP, type AppOptions } from "../src/app.js";
import { hashPassword, readSignedSessionId } from "../src/auth/crypto.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/observability.js";
import { cookieFrom, json, TEST_PASSWORD, testAuth } from "./harness.js";

let store: LedgerStore;
const auth = testAuth();

beforeAll(async () => {
  store = await createPgliteStore();
  const passwordHash = await hashPassword(TEST_PASSWORD, 1_024);
  for (const actorId of ["hardening-owner", "hardening-helper"]) {
    await store.createUser({ actorId, passwordHash, createdAt: new Date().toISOString() });
  }
});

afterEach(() => vi.restoreAllMocks());

function build(overrides: Partial<AppOptions> = {}) {
  return createApp({
    store,
    auth,
    platformAdminActorIds: [],
    logger: silentLogger,
    passwordCost: 1_024,
    http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 100_000 } },
    ...overrides,
  });
}

describe("signup hardening", () => {
  it("disables signup with default non-production config", async () => {
    const config = loadConfig({});
    const app = build({ auth: config.auth, platformAdminActorIds: config.platformAdminActorIds });
    expect(
      (
        await app.request(
          "/auth/signup",
          json("POST", { actorId: "default-new", password: TEST_PASSWORD }),
        )
      ).status,
    ).toBe(403);
    expect(config.platformAdminActorIds).toEqual([]);
  });

  it.each([
    "platform-admin",
    "Platform-Admin ",
    "root",
    "admin",
    "administrator",
    "support",
    "system",
    "nexora",
    "operator-allowed",
    " Operator-Allowed ",
  ])("rejects reserved or allowlisted signup: %s", async (actorId) => {
    const app = build({ platformAdminActorIds: ["operator-allowed"] });
    const rejected = await app.request(
      "/auth/signup",
      json("POST", { actorId, password: TEST_PASSWORD }),
    );
    const taken = await app.request(
      "/auth/signup",
      json("POST", { actorId: "hardening-owner", password: TEST_PASSWORD }),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual(await taken.json());
    expect(await store.findUser(actorId.trim().toLowerCase())).toBeNull();
  });

  it("allows an ordinary signup when explicitly enabled", async () => {
    expect(
      (
        await build().request(
          "/auth/signup",
          json("POST", { actorId: "ordinary-hardening", password: TEST_PASSWORD }),
        )
      ).status,
    ).toBe(201);
  });

  it("refuses signup with platform admins without acknowledgement", () => {
    expect(() =>
      loadConfig({ AUTH_ALLOW_SIGNUP: "true", PLATFORM_ADMIN_ACTOR_IDS: "operator" }),
    ).toThrow(/AUTH_ALLOW_SIGNUP_WITH_PLATFORM_ADMINS/);
    expect(
      loadConfig({
        AUTH_ALLOW_SIGNUP: "true",
        PLATFORM_ADMIN_ACTOR_IDS: "operator",
        AUTH_ALLOW_SIGNUP_WITH_PLATFORM_ADMINS: "true",
      }).auth.allowSignup,
    ).toBe(true);
    expect(loadConfig({ DEMO_MODE: "true" }).platformAdminActorIds).toEqual(["platform-admin"]);
    expect(
      loadConfig({ DEMO_MODE: "true", NEXORA_SEED_DEMO: "false" }).platformAdminActorIds,
    ).toEqual([]);
    expect(
      loadConfig({ DEMO_MODE: "true", DATABASE_URL: "postgres://example/nexora" })
        .platformAdminActorIds,
    ).toEqual([]);
    expect(() => loadConfig({ DEMO_MODE: "true", AUTH_ALLOW_SIGNUP: "true" })).toThrow();
  });
});

function audit(aggregateId: string) {
  return {
    eventId: crypto.randomUUID(),
    eventType: "SupportGranted",
    aggregateType: "membership",
    aggregateId,
    actorId: "hardening-owner",
    correlationId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {},
  };
}

async function supportFixture() {
  const tenantId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const at = Date.now();
  const expiresAt = new Date(at + 1_000).toISOString();
  await store.createTenant({
    tenant: {
      tenantId,
      name: "Support expiry",
      homeRegion: "us-east-1",
      status: "active",
      createdAt: new Date(at).toISOString(),
    },
    ownerActorId: "hardening-owner",
    membershipId: crypto.randomUUID(),
    audit: audit(tenantId),
  });
  await store.grantMembership({
    tenantId,
    membershipId,
    actorId: "hardening-helper",
    role: "auditor",
    audit: audit(membershipId),
  });
  const payload = { actorId: "hardening-helper", membershipId, expiresAt };
  await store.insertWorkspaceRecord({
    tenantId,
    id: grantId,
    kind: "support",
    status: "active",
    payload,
    createdAt: new Date(at).toISOString(),
    audit: audit(grantId),
  });
  vi.spyOn(Date, "now").mockReturnValue(at);
  const app = build();
  const login = await app.request(
    "/auth/login",
    json("POST", { actorId: "hardening-helper", password: TEST_PASSWORD, region: "us-east-1" }),
  );
  expect(login.status).toBe(200);
  const selected = await app.request("/auth/session/tenant", {
    ...json("POST", { tenantId }),
    headers: {
      "content-type": "application/json",
      cookie: cookieFrom(login),
      "x-csrf-token": ((await login.json()) as { csrfToken: string }).csrfToken,
    },
  });
  expect(selected.status).toBe(200);
  const cookie = cookieFrom(selected);
  const csrfToken = ((await selected.json()) as { csrfToken: string }).csrfToken;
  return {
    app,
    tenantId,
    grantId,
    membershipId,
    payload,
    at,
    cookie,
    headers: { cookie, "x-csrf-token": csrfToken },
  };
}

describe("support expiry", () => {
  it("expires concurrent support requests with one grant audit", async () => {
    const fixture = await supportFixture();
    await store.updateWorkspaceRecord({
      tenantId: fixture.tenantId,
      id: fixture.grantId,
      status: "active",
      payload: { ...fixture.payload, expiresAt: new Date(fixture.at - 1_000).toISOString() },
      updatedAt: new Date(fixture.at).toISOString(),
      audit: audit(fixture.grantId),
    });
    const responses = await Promise.all([
      fixture.app.request("/v1/entities", { headers: fixture.headers }),
      fixture.app.request("/v1/entities", { headers: fixture.headers }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "AUTH_SUPPORT_EXPIRED" } });
    }
    expect((await store.listWorkspaceRecords(fixture.tenantId, "support"))[0]?.status).toBe(
      "expired",
    );
    const audits = await store.listAudit(fixture.tenantId);
    expect(
      audits.filter(
        (event) =>
          event.eventType === "SupportExpired" &&
          event.aggregateType === "workspace_record" &&
          event.aggregateId === fixture.grantId,
      ),
    ).toHaveLength(1);
  });

  it.each(["/v1/entities", "/auth/session/rotate", "/auth/session"])(
    "rejects expired access on %s and audits membership removal",
    async (path) => {
      const fixture = await supportFixture();
      vi.mocked(Date.now).mockReturnValue(fixture.at + 1_000);
      const response = await fixture.app.request(path, {
        method: path.endsWith("rotate") ? "POST" : "GET",
        headers: fixture.headers,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "AUTH_SUPPORT_EXPIRED" } });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await store.listRoles(fixture.tenantId, "hardening-helper")).toEqual([]);
      expect((await store.listWorkspaceRecords(fixture.tenantId, "support"))[0]?.status).toBe(
        "expired",
      );
      expect(await store.listAudit(fixture.tenantId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "SupportExpired",
            aggregateId: fixture.membershipId,
          }),
        ]),
      );
      const sessionId = readSignedSessionId(auth.secret, fixture.cookie.split("=")[1] ?? "") ?? "";
      expect((await store.getActiveSession(sessionId))?.tenantId).toBeNull();
      const reselect = await fixture.app.request("/auth/session/tenant", {
        ...json("POST", { tenantId: fixture.tenantId }),
        headers: { ...fixture.headers, "content-type": "application/json" },
      });
      expect(reselect.status).toBe(403);
      expect(await reselect.json()).toMatchObject({ error: { code: "AUTH_SUPPORT_EXPIRED" } });
    },
  );

  it.each(["not-a-date", undefined])("fails closed on invalid expiry: %s", async (expiresAt) => {
    const fixture = await supportFixture();
    await store.updateWorkspaceRecord({
      tenantId: fixture.tenantId,
      id: fixture.grantId,
      status: "active",
      payload: { ...fixture.payload, expiresAt },
      updatedAt: new Date().toISOString(),
      audit: audit(fixture.grantId),
    });
    const response = await fixture.app.request("/v1/entities", { headers: fixture.headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_SUPPORT_EXPIRED" } });
    expect(await store.listRoles(fixture.tenantId, "hardening-helper")).toEqual([]);
  });
});

describe("pre-auth body limits", () => {
  it("rejects malformed credential JSON with a validation error", async () => {
    const response = await build().request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"actorId":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it.each([undefined, "1"])(
    "stops chunked reads at the cap, even with an understated length: %s",
    async (length) => {
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array(8_192).fill(32));
      });
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        duplex: "half",
        body,
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
          ...(length ? { "content-length": length } : {}),
        },
      };
      const parse = vi.spyOn(JSON, "parse");
      const response = await build().request(new Request("http://localhost/auth/login", init));
      const parsedPadding = parse.mock.calls.some(
        ([input]) => typeof input === "string" && /^ +$/.test(input),
      );
      parse.mockRestore();
      expect(response.status).toBe(413);
      expect(pull).toHaveBeenCalledTimes(3);
      expect(cancel).toHaveBeenCalledOnce();
      expect(parsedPadding).toBe(false);
    },
  );

  it("rejects a declared oversize body before reading its stream", async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      duplex: "half",
      body,
      headers: { "content-type": "application/json", "content-length": "1048576" },
    };
    const response = await build().request(new Request("http://localhost/auth/login", init));
    expect(response.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
  });

  it("does not read a body when the general IP bucket is exhausted", async () => {
    const app = build({
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 1, authMax: 100 } },
    });
    expect((await app.request("/auth/config")).status).toBe(200);
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      duplex: "half",
      body,
      headers: { "content-type": "application/json" },
    };
    const response = await app.request(new Request("http://localhost/auth/login", init));
    expect(response.status).toBe(429);
    expect(pull).not.toHaveBeenCalled();
  });

  it("does not parse non-credential JSON in the general limiter", async () => {
    const body = '{"padding":"not-an-identifier"}';
    const parse = vi.spyOn(JSON, "parse");
    const response = await build().request("/v1/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const parses = parse.mock.calls.filter(([input]) => input === body).length;
    parse.mockRestore();
    expect(response.status).toBe(401);
    expect(parses).toBe(0);
  });

  it.each([true, false])(
    "rejects a 1 MiB login before JSON parsing (length header: %s)",
    async (length) => {
      const body = JSON.stringify({ padding: "x".repeat(1_048_576) });
      const parse = vi.spyOn(JSON, "parse");
      const response = await build().request("/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(length ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
        body,
      });
      const parses = parse.mock.calls.filter(([input]) => input === body).length;
      parse.mockRestore();
      expect(response.status).toBe(413);
      expect(parses).toBe(0);
    },
  );

  it.each(["credential", "general"])(
    "checks the %s IP bucket before invalid JSON",
    async (bucket) => {
      const app = build({
        http: {
          ...DEFAULT_HTTP,
          rateLimit: {
            windowMs: 60_000,
            max: bucket === "general" ? 1 : 100,
            authMax: bucket === "credential" ? 1 : 100,
          },
        },
      });
      expect((await app.request("/auth/login", json("POST", {}))).status).toBe(400);
      const body = "{invalid";
      const parse = vi.spyOn(JSON, "parse");
      const response = await app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const parses = parse.mock.calls.filter(([input]) => input === body).length;
      parse.mockRestore();
      expect(response.status).toBe(429);
      expect(parses).toBe(0);
    },
  );

  it("parses a login body once across both limiters and the route", async () => {
    const body = JSON.stringify({
      actorId: "hardening-owner",
      password: TEST_PASSWORD,
      region: "us-east-1",
    });
    const parse = vi.spyOn(JSON, "parse");
    const response = await build().request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const parses = parse.mock.calls.filter(([input]) => input === body).length;
    parse.mockRestore();
    expect(response.status).toBe(200);
    expect(parses).toBe(1);
  });

  it("rejects non-JSON credentials without parsing", async () => {
    const body = '{"actorId":"hardening-owner"}';
    const parse = vi.spyOn(JSON, "parse");
    const response = await build().request("/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    const parses = parse.mock.calls.filter(([input]) => input === body).length;
    parse.mockRestore();
    expect(response.status).toBe(415);
    expect(parses).toBe(0);
  });
});
