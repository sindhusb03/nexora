import { createPgliteStore, type LedgerStore } from "@nexora/db";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp, DEFAULT_HTTP, type AppOptions } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { jsonLogger, silentLogger } from "../src/observability.js";
import { cookieFrom, json, sessions, TEST_PASSWORD, testAuth, type TestApp } from "./harness.js";

const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

describe("signed sessions", () => {
  let store: LedgerStore;
  let app: TestApp;
  let tenantId = "";

  function build(overrides: Partial<AppOptions> = {}): TestApp {
    return createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 100_000 } },
      logger: silentLogger,
      passwordCost: 1_024,
      ...overrides,
    });
  }

  beforeAll(async () => {
    store = await createPgliteStore();
    app = build();
    await sessions(app).register("platform-admin", "owner-1", "auditor-1");
    const provision = await sessions(app).call("POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Session Co", homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    expect(provision.status).toBe(201);
    tenantId = ((await provision.json()) as { tenantId: string }).tenantId;
  });

  it("refuses /v1 without a session, including forged identity headers", async () => {
    const anonymous = await app.request("/v1/entities");
    expect(anonymous.status).toBe(401);
    expect(await errorCode(anonymous)).toBe("AUTH_UNAUTHENTICATED");

    const forged = await app.request("/v1/entities", {
      headers: { "x-actor-id": "owner-1", "x-tenant-id": tenantId, "x-region": "us-east-1" },
    });
    expect(forged.status).toBe(401);
    expect(await errorCode(forged)).toBe("AUTH_UNAUTHENTICATED");

    const forgedProvision = await app.request("/v1/tenants", {
      ...json("POST", { name: "Forged", homeRegion: "us-east-1", ownerActorId: "owner-1" }),
      headers: {
        "content-type": "application/json",
        "x-actor-id": "platform-admin",
        "x-region": "us-east-1",
      },
    });
    expect(forgedProvision.status).toBe(401);
  });

  it("rejects a tampered or unknown session cookie and clears it", async () => {
    const session = await signedIn(app, "owner-1", tenantId);
    const [name, value] = session.cookie.split("=") as [string, string];
    const tampered = `${name}=${value.slice(0, -2)}${value.endsWith("AA") ? "BB" : "AA"}`;
    const response = await app.request("/v1/entities", { headers: { cookie: tampered } });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("AUTH_SESSION_INVALID");
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

    const unsigned = await app.request("/v1/entities", {
      headers: { cookie: `${name}=${crypto.randomUUID()}` },
    });
    expect(unsigned.status).toBe(401);
  });

  it("takes actor, tenant, and region from the session and ignores identity headers", async () => {
    const session = await signedIn(app, "owner-1", tenantId);
    const created = await app.request("/v1/entities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "x-actor-id": "platform-admin",
        "x-tenant-id": OTHER_TENANT,
        "x-region": "eu-central-1",
      },
      body: JSON.stringify({ legalName: "Session Entity", functionalCurrency: "USD" }),
    });
    expect(created.status).toBe(201);

    await sessions(app).call("POST", "/v1/memberships", {
      actor: "owner-1",
      tenant: tenantId,
      body: { actorId: "auditor-1", role: "auditor" },
    });
    const audit = await sessions(app).call("GET", "/v1/audit", {
      actor: "auditor-1",
      tenant: tenantId,
    });
    expect(audit.status).toBe(200);
    const events = (
      (await audit.json()) as { events: Array<{ eventType: string; actorId: string }> }
    ).events;
    const entityEvents = events.filter((event) => event.eventType === "EntityCreated");
    expect(entityEvents.length).toBeGreaterThan(0);
    for (const event of entityEvents) {
      expect(event.actorId).toBe("owner-1");
    }
  });

  it("requires the CSRF token and an allowed Origin on cookie-authenticated writes", async () => {
    const session = await signedIn(app, "owner-1", tenantId);
    const body = JSON.stringify({ legalName: "No Token", functionalCurrency: "USD" });

    const missing = await app.request("/v1/entities", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie },
      body,
    });
    expect(missing.status).toBe(403);
    expect(await errorCode(missing)).toBe("AUTH_CSRF_FAILED");

    const wrong = await app.request("/v1/entities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-csrf-token": "not-the-token",
      },
      body,
    });
    expect(wrong.status).toBe(403);

    const foreign = await app.request("/v1/entities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        origin: "https://attacker.example",
      },
      body,
    });
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe("AUTH_ORIGIN_REJECTED");

    const read = await app.request("/v1/entities", { headers: { cookie: session.cookie } });
    expect(read.status).toBe(200);
  });

  it("refuses bad credentials without revealing which part was wrong", async () => {
    const wrongPassword = await app.request(
      "/auth/login",
      json("POST", { actorId: "owner-1", password: "wrong-password-123", region: "us-east-1" }),
    );
    const unknownActor = await app.request(
      "/auth/login",
      json("POST", { actorId: "nobody-here", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(unknownActor.status).toBe(401);
    expect(await errorCode(wrongPassword)).toBe("AUTH_INVALID_CREDENTIALS");
    expect(await errorCode(unknownActor)).toBe("AUTH_INVALID_CREDENTIALS");
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();

    const weak = await app.request(
      "/auth/signup",
      json("POST", { actorId: "weak-user", password: "short" }),
    );
    expect(weak.status).toBe(400);
    const taken = await app.request(
      "/auth/signup",
      json("POST", { actorId: "owner-1", password: TEST_PASSWORD }),
    );
    expect(taken.status).toBe(409);
  });

  it("only selects a tenant the actor belongs to in the session's region", async () => {
    await sessions(app).register("stranger-1");
    const stranger = await sessions(app).session("stranger-1", "us-east-1", tenantId);
    expect(stranger).toBeInstanceOf(Response);
    expect((stranger as Response).status).toBe(403);

    const missing = await sessions(app).session("owner-1", "us-east-1", OTHER_TENANT);
    expect((missing as Response).status).toBe(404);

    const wrongRegion = await sessions(app).session("owner-1", "eu-central-1", tenantId);
    expect(await errorCode(wrongRegion as Response)).toBe("REGION_MISMATCH");
  });

  it("refuses to grant membership to an actor that has not registered", async () => {
    const grant = await sessions(app).call("POST", "/v1/memberships", {
      actor: "owner-1",
      tenant: tenantId,
      body: { actorId: "ghost-actor", role: "viewer" },
    });
    expect(grant.status).toBe(404);

    const provision = await sessions(app).call("POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: "Ghost Co", homeRegion: "us-east-1", ownerActorId: "ghost-actor" },
    });
    expect(provision.status).toBe(404);
  });

  it("revokes the session on logout", async () => {
    const login = await app.request(
      "/auth/login",
      json("POST", { actorId: "owner-1", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const cookie = cookieFrom(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const refused = await app.request("/auth/logout", { method: "POST", headers: { cookie } });
    expect(refused.status).toBe(403);

    const logout = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(logout.status).toBe(204);

    const after = await app.request("/auth/session", { headers: { cookie } });
    expect(after.status).toBe(401);
    expect(await errorCode(after)).toBe("AUTH_SESSION_INVALID");
  });

  it("ends a session at its expiry", async () => {
    const shortLived = build({ auth: testAuth({ sessionTtlSeconds: 1 }) });
    const login = await shortLived.request(
      "/auth/login",
      json("POST", { actorId: "owner-1", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    expect((await shortLived.request("/auth/session", { headers: { cookie } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const expired = await shortLived.request("/auth/session", { headers: { cookie } });
    expect(expired.status).toBe(401);
  });

  it("refuses sign-up when the deployment disables it", async () => {
    const closed = build({ auth: testAuth({ allowSignup: false }) });
    const response = await closed.request(
      "/auth/signup",
      json("POST", { actorId: "new-user", password: TEST_PASSWORD }),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("AUTH_SIGNUP_DISABLED");
    const config = (await (await closed.request("/auth/config")).json()) as {
      signupAllowed: boolean;
    };
    expect(config.signupAllowed).toBe(false);
  });

  it("trusts identity headers only when the dev flag is on", async () => {
    const dev = build({ auth: testAuth({ devHeaders: true }) });
    const listed = await dev.request("/v1/entities", {
      headers: { "x-actor-id": "owner-1", "x-tenant-id": tenantId, "x-region": "us-east-1" },
    });
    expect(listed.status).toBe(200);

    const devPreflight = await dev.request("/v1/entities", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    expect(devPreflight.headers.get("access-control-allow-headers") ?? "").toContain("x-actor-id");

    const preflight = await app.request("/v1/entities", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    const allowed = preflight.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toContain("x-csrf-token");
    expect(allowed).not.toContain("x-actor-id");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("limits credential attempts and request bodies", async () => {
    const limited = build({
      http: {
        ...DEFAULT_HTTP,
        bodyLimitBytes: 2_048,
        rateLimit: { windowMs: 60_000, max: 100_000, authMax: 3 },
      },
    });
    const attempt = () =>
      limited.request(
        "/auth/login",
        json("POST", { actorId: "owner-1", password: "wrong-password-123", region: "us-east-1" }),
      );
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe("RATE_LIMITED");
    expect(blocked.headers.get("retry-after")).not.toBeNull();

    const large = await limited.request("/v1/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(4_096) }),
    });
    expect(large.status).toBe(413);
    expect(await errorCode(large)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("sets security headers, echoes a request id, and reports readiness", async () => {
    const health = await app.request("/health", { headers: { "x-request-id": "req-12345678" } });
    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toBe("req-12345678");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'");

    const generated = await app.request("/health", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const session = await signedIn(app, "owner-1", tenantId);
    const entities = await app.request("/v1/entities", { headers: { cookie: session.cookie } });
    expect(entities.headers.get("cache-control")).toBe("no-store");

    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { status: string }).status).toBe("ready");

    const failing = build({
      store: {
        ...store,
        ping: () => Promise.reject(new Error("connection refused for postgres://user:secret@host")),
      },
    });
    const notReady = await failing.request("/ready");
    expect(notReady.status).toBe(503);
    expect(JSON.stringify(await notReady.json())).not.toContain("secret");
  });

  it("never writes passwords, cookies, or CSRF tokens to logs", async () => {
    const lines: string[] = [];
    const logged = build({ logger: jsonLogger((line) => lines.push(line)) });
    const login = await logged.request(
      "/auth/login",
      json("POST", { actorId: "owner-1", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const cookie = cookieFrom(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    await logged.request(
      "/auth/login",
      json("POST", { actorId: "owner-1", password: "wrong-password-123", region: "us-east-1" }),
    );
    await logged.request("/v1/entities", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ legalName: "Logged Entity", functionalCurrency: "USD" }),
    });

    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).not.toContain(TEST_PASSWORD);
    expect(output).not.toContain("wrong-password-123");
    expect(output).not.toContain(cookie.split("=")[1]);
    expect(output).not.toContain(csrfToken);
    expect(output).not.toContain("Logged Entity");
    for (const line of lines) {
      const entry = JSON.parse(line) as { event: string; requestId?: string };
      if (entry.event === "http.request") expect(entry.requestId).toBeTruthy();
    }
  });

  it("lets a registered user open a company in their own name", async () => {
    const opened = await sessions(app).call("POST", "/v1/tenants", {
      actor: "owner-2",
      region: "us-east-1",
      body: { name: "Owner Two Co", homeRegion: "us-east-1", ownerActorId: "owner-2" },
    });
    expect(opened.status).toBe(201);
    const openedBody = (await opened.json()) as { tenantId: string; name: string };
    expect(openedBody.name).toBe("Owner Two Co");

    const forSomeoneElse = await sessions(app).call("POST", "/v1/tenants", {
      actor: "owner-2",
      region: "us-east-1",
      body: { name: "Not Theirs", homeRegion: "us-east-1", ownerActorId: "auditor-1" },
    });
    expect(forSomeoneElse.status).toBe(403);
    expect(await errorCode(forSomeoneElse)).toBe("AUTH_SCOPE_DENIED");

    const otherRegion = await sessions(app).call("POST", "/v1/tenants", {
      actor: "owner-2",
      region: "us-east-1",
      body: { name: "Wrong Region", homeRegion: "eu-west-1", ownerActorId: "owner-2" },
    });
    expect(otherRegion.status).toBe(403);
    expect(await errorCode(otherRegion)).toBe("REGION_MISMATCH");

    const selected = await sessions(app).call("POST", "/auth/session/tenant", {
      actor: "owner-2",
      region: "us-east-1",
      body: { tenantId: openedBody.tenantId },
    });
    expect(selected.status).toBe(200);

    const entity = await sessions(app).call("POST", "/v1/entities", {
      actor: "owner-2",
      tenant: openedBody.tenantId,
      region: "us-east-1",
      body: { legalName: "Owner Two Co", functionalCurrency: "USD" },
    });
    expect(entity.status).toBe(201);
  });
});

describe("configuration", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://nexora_api@db.internal/nexora",
    AUTH_SECRET: "a".repeat(48),
    WEB_ORIGIN: "https://app.example.com",
  };

  it("fails closed in production", () => {
    expect(() => loadConfig({ ...production, DATABASE_URL: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, AUTH_SECRET: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, AUTH_SECRET: "too-short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, NEXORA_DEV_HEADERS: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, AUTH_COOKIE_SECURE: "false" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, WEB_ORIGIN: "https://app.example.com/path" })).toThrow(
      ConfigError,
    );
  });

  it("uses safe production defaults", () => {
    const config = loadConfig(production);
    expect(config.auth.devHeaders).toBe(false);
    expect(config.auth.allowSignup).toBe(false);
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.platformAdminActorIds).toEqual([]);
    expect(config.warnings).toEqual([]);
  });

  it("keeps development usable and says so", () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toBeNull();
    expect(config.auth.devHeaders).toBe(false);
    expect(config.auth.allowSignup).toBe(true);
    expect(config.auth.secret.length).toBeGreaterThanOrEqual(32);
    expect(config.warnings.some((warning) => warning.includes("AUTH_SECRET"))).toBe(true);
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({
      ...production,
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      PLATFORM_ADMIN_ACTOR_IDS: " ",
    });
    expect(config.otelEndpoint).toBeNull();
    expect(config.platformAdminActorIds).toEqual([]);
    expect(() => loadConfig({ ...production, AUTH_SECRET: "" })).toThrow(ConfigError);
  });
});

async function signedIn(app: TestApp, actor: string, tenant: string) {
  const session = await sessions(app).session(actor, "us-east-1", tenant);
  if (session instanceof Response) {
    throw new Error(`sign-in for ${actor} returned ${session.status}`);
  }
  return session;
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}
