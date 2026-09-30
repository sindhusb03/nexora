import { createPgliteStore } from "@nexora/db";

import { createApp, DEFAULT_HTTP, type AppOptions } from "../src/app.js";
import type { AuthConfig } from "../src/config.js";
import { silentLogger } from "../src/observability.js";

export type TestApp = ReturnType<typeof createApp>;

export const TEST_PASSWORD = "correct horse battery staple";

export const TEST_ACTORS = ["platform-admin", "owner-1", "owner-2", "controller-1", "viewer-1", "auditor-1"] as const;

export function testAuth(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: "test-only-secret-that-is-long-enough-000000",
    sessionTtlSeconds: 3_600,
    allowSignup: true,
    devHeaders: false,
    cookieSecure: false,
    cookieSameSite: "Lax",
    pinnedRegion: null,
    ...overrides,
  };
}

export async function testApp(overrides: Partial<AppOptions> = {}): Promise<TestApp> {
  return createApp({
    store: await createPgliteStore(),
    platformAdminActorIds: ["platform-admin"],
    auth: testAuth(),
    http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 100_000 } },
    logger: silentLogger,
    passwordCost: 1_024,
    ...overrides,
  });
}

export interface CallOptions {
  actor?: string;
  tenant?: string;
  region?: string;
  idempotency?: string;
  expectedVersion?: string;
  body?: unknown;
}

export interface SignedSession {
  readonly cookie: string;
  readonly csrfToken: string;
}

/** Registers actors, signs them in through /auth, and replays each session's cookie and CSRF token. */
class SessionClient {
  private readonly sessions = new Map<string, SignedSession>();
  private readonly registered = new Set<string>();

  constructor(private readonly app: TestApp) {}

  async register(...actors: string[]): Promise<void> {
    for (const actor of actors) {
      if (this.registered.has(actor)) continue;
      const response = await this.app.request("/auth/signup", json("POST", { actorId: actor, password: TEST_PASSWORD }));
      if (response.status !== 201 && response.status !== 409) {
        throw new Error(`signup for ${actor} returned ${response.status}`);
      }
      this.registered.add(actor);
    }
  }

  /** Returns the signed session, or the failed /auth response when sign-in or tenant selection is refused. */
  async session(actor: string, region: string, tenant: string | null): Promise<SignedSession | Response> {
    const key = `${actor}|${region}|${tenant ?? ""}`;
    const cached = this.sessions.get(key);
    if (cached) return cached;
    await this.register(actor);
    const login = await this.app.request("/auth/login", json("POST", { actorId: actor, password: TEST_PASSWORD, region }));
    if (login.status !== 200) return login;
    const session = { cookie: cookieFrom(login), csrfToken: ((await login.json()) as { csrfToken: string }).csrfToken };
    if (tenant) {
      const selected = await this.app.request("/auth/session/tenant", {
        ...json("POST", { tenantId: tenant }),
        headers: { "content-type": "application/json", cookie: session.cookie, "x-csrf-token": session.csrfToken },
      });
      if (selected.status !== 200) return selected;
    }
    this.sessions.set(key, session);
    return session;
  }

  async call(method: string, path: string, options: CallOptions): Promise<Response> {
    const headers = new Headers();
    if (options.actor) {
      const session = await this.session(options.actor, options.region ?? "us-east-1", options.tenant ?? null);
      if (session instanceof Response) return session;
      headers.set("cookie", session.cookie);
      headers.set("x-csrf-token", session.csrfToken);
    }
    if (options.idempotency) headers.set("idempotency-key", options.idempotency);
    if (options.expectedVersion) headers.set("expected-version", options.expectedVersion);
    if (options.body === undefined) {
      return this.app.request(path, { method, headers });
    }
    headers.set("content-type", "application/json");
    return this.app.request(path, { method, headers, body: JSON.stringify(options.body) });
  }
}

const clients = new WeakMap<TestApp, SessionClient>();

export function sessions(app: TestApp): SessionClient {
  let client = clients.get(app);
  if (!client) {
    client = new SessionClient(app);
    clients.set(app, client);
  }
  return client;
}

export function call(app: TestApp, method: string, path: string, options: CallOptions): Promise<Response> {
  return sessions(app).call(method, path, options);
}

export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const pair = header.split(";")[0] ?? "";
  if (!pair.includes("=")) {
    throw new Error("response did not set a session cookie");
  }
  return pair;
}
