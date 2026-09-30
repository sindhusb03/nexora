import { createPgliteStore, type LedgerStore } from "@nexora/db";
import { beforeAll, describe, expect, it } from "vitest";

import { MemoryMailbox, consoleEmailSender } from "../src/auth/email.js";
import { sha256 } from "../src/auth/oidc.js";
import { lockoutSubject, nextLockout } from "../src/auth/lockout.js";
import {
  ARGON2_MEMORY_KIB,
  ARGON2_TIME_COST,
  argon2Params,
  hashPassword,
  verifyPassword,
} from "../src/auth/crypto.js";
import { hashRecoveryCode, totpCode, verifyTotp } from "../src/auth/totp.js";
import { createApp, DEFAULT_HTTP, type AppOptions } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { silentLogger } from "../src/observability.js";
import { cookieFrom, json, sessions, TEST_PASSWORD, testAuth, type TestApp } from "./harness.js";

describe("password hashing", () => {
  it("stores argon2id and rejects a wrong password or a broken scrypt string", async () => {
    const stored = await hashPassword(TEST_PASSWORD, 1_024);
    expect(argon2Params()).toEqual({ memoryKiB: ARGON2_MEMORY_KIB, timeCost: ARGON2_TIME_COST });
    expect(stored.startsWith("$argon2id$v=19$m=1024,t=1,p=1$")).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("wrong-password-123", stored)).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, "scrypt$1$8$1$aa$bb")).toBe(false);
  });

  it("accepts the current authenticator step and the next lockout threshold", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(verifyTotp(secret, "000000", now)).toBe(false);
    const first = nextLockout(null, new Date(now));
    expect(first.failures).toBe(1);
    expect(first.lockedUntil).toBeNull();
    let state = first;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      state = nextLockout(state, new Date(now + 1_000));
    }
    expect(state.failures).toBe(5);
    expect(state.lockedUntil).not.toBeNull();
    expect(lockoutSubject("password", "Owner-1")).toBe(lockoutSubject("password", "owner-1"));
    const hmacKey = "test-only-secret-that-is-long-enough-000000";
    expect(hashRecoveryCode("ABCD-EFGH", hmacKey)).toBe(hashRecoveryCode("abcdefgh", hmacKey));
    expect(hashRecoveryCode("ABCD-EFGH", hmacKey)).not.toBe(hashRecoveryCode("ABCD-EFGH", "other"));
  });
});

describe("magic link, second factor, rotation, and audit", () => {
  let store: LedgerStore;
  let app: TestApp;
  let mailbox: MemoryMailbox;

  function build(overrides: Partial<AppOptions> = {}): TestApp {
    return createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 100_000 } },
      logger: silentLogger,
      passwordCost: 1_024,
      email: consoleEmailSender(silentLogger, mailbox),
      devMailbox: mailbox,
      demoMode: true,
      ...overrides,
    });
  }

  beforeAll(async () => {
    store = await createPgliteStore();
    mailbox = new MemoryMailbox();
    app = build();
  });

  it("sends a one-time magic link through the dev transport without echoing the address", async () => {
    const signup = await app.request(
      "/auth/signup",
      json("POST", {
        actorId: "mail-user",
        email: "mail.user@example.com",
        password: TEST_PASSWORD,
      }),
    );
    expect(signup.status).toBe(201);

    const unknown = await app.request(
      "/auth/magic-link",
      json("POST", { email: "missing@example.com" }),
    );
    const known = await app.request(
      "/auth/magic-link",
      json("POST", { email: "mail.user@example.com" }),
    );
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(await unknown.json()).toEqual(await known.json());

    const message = mailbox.list().find((item) => item.to === "mail.user@example.com");
    expect(message?.text).toContain("/studio?magic=");
    const token = /magic=([A-Za-z0-9-]+)/.exec(message?.text ?? "")?.[1];
    expect(token).toBeTruthy();

    const consumed = await app.request(
      "/auth/magic-link/consume",
      json("POST", { token, region: "us-east-1" }),
    );
    expect(consumed.status).toBe(200);
    expect(cookieFrom(consumed)).toContain("nexora_session=");
    const again = await app.request(
      "/auth/magic-link/consume",
      json("POST", { token, region: "us-east-1" }),
    );
    expect(again.status).toBe(401);
  });

  it("enrolls TOTP, then requires a code or a recovery code at sign-in", async () => {
    await sessions(app).register("totp-user");
    const login = await app.request(
      "/auth/login",
      json("POST", { actorId: "totp-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const cookie = cookieFrom(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const enroll = await app.request("/auth/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(enroll.status).toBe(200);
    const enrolled = (await enroll.json()) as {
      secret: string;
      qrDataUrl: string;
      otpauthUrl: string;
    };
    expect(enrolled.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(enrolled.otpauthUrl.startsWith("otpauth://totp/")).toBe(true);

    const confirm = await app.request("/auth/2fa/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ code: totpCode(enrolled.secret) }),
    });
    expect(confirm.status).toBe(200);
    const recoveryCodes = ((await confirm.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(recoveryCodes.length).toBeGreaterThan(0);
    const recoveryCode = recoveryCodes[0];
    expect(recoveryCode).toBeTruthy();

    const challenged = await app.request(
      "/auth/login",
      json("POST", { actorId: "totp-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    expect(challenged.status).toBe(200);
    expect(challenged.headers.get("set-cookie")).toBeNull();
    const { challengeId, mfaRequired } = (await challenged.json()) as {
      challengeId: string;
      mfaRequired: boolean;
    };
    expect(mfaRequired).toBe(true);

    const verified = await app.request(
      "/auth/2fa/verify",
      json("POST", { challengeId, code: totpCode(enrolled.secret) }),
    );
    expect(verified.status).toBe(200);
    expect(cookieFrom(verified)).toContain("nexora_session=");

    const second = await app.request(
      "/auth/login",
      json("POST", { actorId: "totp-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const secondChallenge = ((await second.json()) as { challengeId: string }).challengeId;
    const recovered = await app.request(
      "/auth/2fa/verify",
      json("POST", { challengeId: secondChallenge, recoveryCode }),
    );
    expect(recovered.status).toBe(200);
    const reused = await app.request(
      "/auth/login",
      json("POST", { actorId: "totp-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const reusedChallenge = ((await reused.json()) as { challengeId: string }).challengeId;
    const denied = await app.request(
      "/auth/2fa/verify",
      json("POST", { challengeId: reusedChallenge, recoveryCode }),
    );
    expect(denied.status).toBe(401);
  });

  it("rotates the session and revokes the family when a revoked cookie is presented", async () => {
    const login = await app.request(
      "/auth/login",
      json("POST", { actorId: "mail-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const first = cookieFrom(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const rotated = await app.request("/auth/session/rotate", {
      method: "POST",
      headers: { cookie: first, "x-csrf-token": csrfToken },
    });
    expect(rotated.status).toBe(200);
    const second = cookieFrom(rotated);
    const secondToken = ((await rotated.json()) as { csrfToken: string }).csrfToken;
    expect(second).not.toBe(first);

    const reuse = await app.request("/auth/session", { headers: { cookie: first } });
    expect(reuse.status).toBe(401);
    const killed = await app.request("/auth/session", {
      headers: { cookie: second, "x-csrf-token": secondToken },
    });
    expect(killed.status).toBe(401);
  });

  it("locks the identifier after repeated failures without saying whether it exists", async () => {
    await sessions(app).register("lock-user");
    const limited = build({
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 100 } },
    });
    const attempt = (actorId: string) =>
      limited.request(
        "/auth/login",
        json("POST", { actorId, password: "wrong-password-123", region: "us-east-1" }),
      );
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt("lock-user")).status).toBe(401);
      expect((await attempt("nobody-locks")).status).toBe(401);
    }
    const known = await attempt("lock-user");
    const unknown = await attempt("nobody-locks");
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(await errorCode(known)).toBe("AUTH_LOCKED");
    expect(await errorCode(unknown)).toBe("AUTH_LOCKED");
  });

  it("records auth events the actor can read and hides another actor's events", async () => {
    const login = await app.request(
      "/auth/login",
      json("POST", { actorId: "mail-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const cookie = cookieFrom(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const audit = await app.request("/auth/audit", {
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(audit.status).toBe(200);
    const events = (
      (await audit.json()) as { events: Array<{ eventType: string; actorId: string | null }> }
    ).events;
    expect(events.some((event) => event.eventType === "login_success")).toBe(true);
    expect(events.some((event) => event.eventType === "magic_link_used")).toBe(true);
    expect(events.every((event) => event.actorId === "mail-user" || event.actorId === null)).toBe(
      true,
    );

    await sessions(app).register("other-user");
    const other = await sessions(app).session("other-user", "us-east-1", null);
    if (other instanceof Response) throw new Error("other user did not sign in");
    const otherAudit = await app.request("/auth/audit", {
      headers: { cookie: other.cookie, "x-csrf-token": other.csrfToken },
    });
    const otherEvents = ((await otherAudit.json()) as { events: Array<{ actorId: string | null }> })
      .events;
    expect(otherEvents.every((event) => event.actorId !== "mail-user")).toBe(true);
  });

  it("keeps the OIDC callback as a skeleton until a provider completes token exchange", async () => {
    const missing = await app.request("/auth/oidc/google/start");
    expect(missing.status).toBe(404);

    const configured = build({
      oidcProviders: [
        {
          id: "google",
          label: "Google",
          issuer: "https://accounts.example.com",
          clientId: "nexora-client",
          clientSecret: null,
          redirectUri: "http://127.0.0.1:4317/auth/oidc/google/callback",
          scopes: ["openid", "email"],
        },
      ],
    });
    const start = await configured.request("/auth/oidc/google/start");
    expect(start.status).toBe(302);
    const location = start.headers.get("location") ?? "";
    expect(location.startsWith("https://accounts.example.com/authorize?")).toBe(true);
    const state = new URL(location).searchParams.get("state");
    expect(state).toBeTruthy();

    const bare = await configured.request("/auth/oidc/google/callback");
    expect(bare.status).toBe(400);
    const callback = await configured.request(
      `/auth/oidc/google/callback?state=${state}&code=sample-code`,
    );
    expect(callback.status).toBe(501);
    expect(await errorCode(callback)).toBe("AUTH_OIDC_NOT_COMPLETED");

    const linked = await store.linkOidcAccount({
      linkId: crypto.randomUUID(),
      actorId: "mail-user",
      issuer: "https://accounts.example.com",
      subject: "subject-1",
      createdAt: new Date().toISOString(),
    });
    expect(linked).toBe("linked");
    expect(await store.findOidcLink("https://accounts.example.com", "subject-1")).toEqual({
      actorId: "mail-user",
    });
    const conflict = await store.linkOidcAccount({
      linkId: crypto.randomUUID(),
      actorId: "totp-user",
      issuer: "https://accounts.example.com",
      subject: "subject-1",
      createdAt: new Date().toISOString(),
    });
    expect(conflict).toBe("conflict");
  });
});

describe("auth regressions", () => {
  let store: LedgerStore;
  let app: TestApp;
  let mailbox: MemoryMailbox;

  beforeAll(async () => {
    store = await createPgliteStore();
    mailbox = new MemoryMailbox();
    app = createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 100_000 } },
      logger: silentLogger,
      passwordCost: 1_024,
      email: consoleEmailSender(silentLogger, mailbox),
      devMailbox: mailbox,
      demoMode: true,
    });
    await app.request(
      "/auth/signup",
      json("POST", {
        actorId: "enum-user",
        email: "enum.user@example.com",
        password: TEST_PASSWORD,
      }),
    );
  });

  it("does not distinguish known and unknown magic-link addresses", async () => {
    const codesFor = async (email: string) => {
      const codes: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        codes.push((await app.request("/auth/magic-link", json("POST", { email }))).status);
      }
      return codes;
    };
    const unknown = await codesFor("nobody-enum@example.com");
    const known = await codesFor("enum.user@example.com");
    expect(known).toEqual(unknown);
    expect(known.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(known[5]).toBe(429);
  });

  it("rejects an expired magic link", async () => {
    const token = `expired-${crypto.randomUUID()}`;
    await store.createMagicLink({
      tokenHash: sha256(token),
      actorId: "enum-user",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const response = await app.request(
      "/auth/magic-link/consume",
      json("POST", { token, region: "us-east-1" }),
    );
    expect(response.status).toBe(401);
  });

  it("locks TOTP verification and rejects a replayed code", async () => {
    await sessions(app).register("brute-user");
    const login = await app.request(
      "/auth/login",
      json("POST", { actorId: "brute-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const cookie = cookieFrom(login);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const enroll = await app.request("/auth/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const secret = ((await enroll.json()) as { secret: string }).secret;
    await app.request("/auth/2fa/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ code: totpCode(secret) }),
    });
    const challenged = await app.request(
      "/auth/login",
      json("POST", { actorId: "brute-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const { challengeId } = (await challenged.json()) as { challengeId: string };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await app.request(
        "/auth/2fa/verify",
        json("POST", { challengeId, code: "000000" }),
      );
      expect(wrong.status).toBe(401);
    }
    const blocked = await app.request(
      "/auth/2fa/verify",
      json("POST", { challengeId, code: totpCode(secret) }),
    );
    expect(blocked.status).toBe(429);

    await sessions(app).register("replay-user");
    const replayLogin = await app.request(
      "/auth/login",
      json("POST", { actorId: "replay-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const replayCookie = cookieFrom(replayLogin);
    const replayCsrf = ((await replayLogin.json()) as { csrfToken: string }).csrfToken;
    const replayEnroll = await app.request("/auth/2fa/enroll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: replayCookie,
        "x-csrf-token": replayCsrf,
      },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const replaySecret = ((await replayEnroll.json()) as { secret: string }).secret;
    const code = totpCode(replaySecret);
    await app.request("/auth/2fa/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: replayCookie,
        "x-csrf-token": replayCsrf,
      },
      body: JSON.stringify({ code }),
    });
    const first = await app.request(
      "/auth/login",
      json("POST", { actorId: "replay-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const firstChallenge = ((await first.json()) as { challengeId: string }).challengeId;
    expect(
      (await app.request("/auth/2fa/verify", json("POST", { challengeId: firstChallenge, code })))
        .status,
    ).toBe(200);
    const second = await app.request(
      "/auth/login",
      json("POST", { actorId: "replay-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const secondChallenge = ((await second.json()) as { challengeId: string }).challengeId;
    expect(
      (await app.request("/auth/2fa/verify", json("POST", { challengeId: secondChallenge, code })))
        .status,
    ).toBe(401);
    const disabled = await app.request("/auth/2fa/disable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: replayCookie,
        "x-csrf-token": replayCsrf,
      },
      body: JSON.stringify({ password: TEST_PASSWORD, code }),
    });
    expect(disabled.status).toBe(200);
    const plain = await app.request(
      "/auth/login",
      json("POST", { actorId: "replay-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    expect(plain.headers.get("set-cookie")).toContain("nexora_session=");
  });

  it("rate limits magic-link and second-factor calls", async () => {
    const limited = createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 3 } },
      logger: silentLogger,
      passwordCost: 1_024,
      demoMode: true,
    });
    const magic = () =>
      limited.request("/auth/magic-link", json("POST", { email: "rate@example.com" }));
    expect((await magic()).status).toBe(202);
    expect((await magic()).status).toBe(202);
    expect((await magic()).status).toBe(202);
    const blockedMagic = await magic();
    expect(blockedMagic.status).toBe(429);
    expect(await errorCode(blockedMagic)).toBe("RATE_LIMITED");
    const verifyApp = createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      http: { ...DEFAULT_HTTP, rateLimit: { windowMs: 60_000, max: 100_000, authMax: 3 } },
      logger: silentLogger,
      passwordCost: 1_024,
      demoMode: true,
    });
    const verify = () =>
      verifyApp.request(
        "/auth/2fa/verify",
        json("POST", { challengeId: "00000000-0000-4000-8000-000000000001", code: "000000" }),
      );
    expect((await verify()).status).toBe(401);
    expect((await verify()).status).toBe(401);
    expect((await verify()).status).toBe(401);
    const blockedVerify = await verify();
    expect(blockedVerify.status).toBe(429);
    expect(await errorCode(blockedVerify)).toBe("RATE_LIMITED");
  });

  it("hides the dev mailbox unless demo mode is on outside production", async () => {
    const hidden = createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      logger: silentLogger,
      passwordCost: 1_024,
      devMailbox: mailbox,
      demoMode: false,
      production: false,
    });
    expect((await hidden.request("/auth/dev/mailbox")).status).toBe(404);
    const open = createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth(),
      logger: silentLogger,
      passwordCost: 1_024,
      devMailbox: mailbox,
      demoMode: true,
      production: false,
    });
    expect((await open.request("/auth/dev/mailbox")).status).toBe(200);
  });

  it("rejects a sign-in region that is not the deployment region", async () => {
    const pinned = createApp({
      store,
      platformAdminActorIds: ["platform-admin"],
      auth: testAuth({ pinnedRegion: "ap-south-1" }),
      logger: silentLogger,
      passwordCost: 1_024,
      demoMode: false,
    });
    const mismatch = await pinned.request(
      "/auth/login",
      json("POST", { actorId: "enum-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    expect(mismatch.status).toBe(403);
    expect(await errorCode(mismatch)).toBe("REGION_MISMATCH");
    const matched = await pinned.request(
      "/auth/login",
      json("POST", { actorId: "enum-user", password: TEST_PASSWORD, region: "ap-south-1" }),
    );
    expect(matched.status).toBe(200);
  });

  it("ends the presented session when a magic link signs in", async () => {
    await app.request(
      "/auth/signup",
      json("POST", {
        actorId: "fresh-user",
        email: "fresh.user@example.com",
        password: TEST_PASSWORD,
      }),
    );
    const first = await app.request(
      "/auth/login",
      json("POST", { actorId: "enum-user", password: TEST_PASSWORD, region: "us-east-1" }),
    );
    const oldCookie = cookieFrom(first);
    await app.request("/auth/magic-link", json("POST", { email: "fresh.user@example.com" }));
    const token = /magic=([A-Za-z0-9-]+)/.exec(
      mailbox.list().find((item) => item.to === "fresh.user@example.com")?.text ?? "",
    )?.[1];
    const next = await app.request("/auth/magic-link/consume", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: oldCookie },
      body: JSON.stringify({ token, region: "us-east-1" }),
    });
    expect(next.status).toBe(200);
    const stale = await app.request("/auth/session", { headers: { cookie: oldCookie } });
    expect(stale.status).toBe(401);
  });

  it("refuses a weak password cost in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(hashPassword(TEST_PASSWORD, 1_024)).rejects.toThrow(/production argon2id/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    expect(() =>
      createApp({
        store,
        platformAdminActorIds: ["platform-admin"],
        auth: testAuth(),
        logger: silentLogger,
        production: true,
        passwordCost: 1_024,
      }),
    ).toThrow(ConfigError);
  });
});

describe("demo mode configuration", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://nexora_api@db.internal/nexora",
    AUTH_SECRET: "a".repeat(48),
    WEB_ORIGIN: "https://app.example.com",
  };

  it("stays off unless DEMO_MODE=true and is refused in production", () => {
    expect(loadConfig({}).demoMode).toBe(false);
    expect(loadConfig({ DEMO_MODE: "true" }).demoMode).toBe(true);
    expect(loadConfig(production).demoMode).toBe(false);
    expect(() => loadConfig({ ...production, DEMO_MODE: "true" })).toThrow(ConfigError);
    expect(
      loadConfig({ ...production, SENTRY_DSN: "https://abc@sentry.example/1" }).sentryDsn,
    ).toContain("sentry.example");
    expect(() => loadConfig({ ...production, SENTRY_DSN: "http://insecure" })).toThrow(ConfigError);
  });
});

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}
