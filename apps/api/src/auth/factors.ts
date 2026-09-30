import type { AuthUserRecord, LedgerStore } from "@nexora/db";
import type { Hono } from "hono";
import QRCode from "qrcode";
import { z } from "zod";

import type { AuthConfig } from "../config.js";
import { ApiError, type AppContext, type AppEnv } from "../http.js";
import type { Logger } from "../observability.js";
import type { EmailSender, MemoryMailbox } from "./email.js";
import { verifyPassword } from "./crypto.js";
import { endPresentedSession, issueSession, recordAuth } from "./issue.js";
import {
  lockedRetry,
  lockoutStatus,
  lockoutSubject,
  nextLockout,
  passwordSubjects,
  strictestLockout,
} from "./lockout.js";
import { sha256, startOidc, type OidcProviderConfig } from "./oidc.js";
import { openSecret, sealSecret } from "./secret-box.js";
import { assertCsrf, assertOrigin, clearSessionCookie, lookupSession } from "./session.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchingTotpStep,
  totpAuthUrl,
  verifyTotp,
} from "./totp.js";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MAGIC_TTL_MS = 15 * 60 * 1000;
/** Both magic-link outcomes wait out this floor so a known address is not faster. */
const MAGIC_RESPONSE_FLOOR_MS = 40;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const magicSchema = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL, "Enter a valid email address"),
});
const consumeSchema = z.object({
  token: z.string().trim().min(20).max(200),
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/)
    .optional(),
});
const confirmSchema = z.object({
  code: z.string().trim().min(6).max(8),
});
const enrollSchema = z.object({
  password: z.string().min(1).max(200),
});
const disableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(12),
});
const verifySchema = z
  .object({
    challengeId: z.uuid(),
    code: z.string().trim().min(6).max(12).optional(),
    recoveryCode: z.string().trim().min(8).max(32).optional(),
  })
  .refine((value) => value.code !== undefined || value.recoveryCode !== undefined, {
    message: "Enter an authenticator code or a recovery code",
  });

export interface FactorDeps {
  readonly store: LedgerStore;
  readonly auth: AuthConfig;
  readonly webOrigins: readonly string[];
  readonly logger: Logger;
  readonly email: EmailSender;
  readonly devMailbox: MemoryMailbox | null;
  readonly oidcProviders: readonly OidcProviderConfig[];
  readonly platformAdminActorIds: readonly string[];
  readonly regionFor: (requested: string | undefined) => string;
}

export function registerFactorRoutes(app: Hono<AppEnv>, deps: FactorDeps): void {
  const { store, auth, logger } = deps;

  app.post("/auth/magic-link", async (c) => {
    assertOrigin(c, deps.webOrigins);
    const body = magicSchema.parse(await c.req.json());
    const subject = lockoutSubject("magic", body.email);
    const now = new Date();
    const current = await store.readLockout(subject);
    const status = lockoutStatus(current, now);
    if (status.locked) {
      c.header("retry-after", String(status.retryAfterSeconds));
      throw new ApiError(
        429,
        "AUTH_LOCKED",
        "Sign-in is temporarily unavailable. Try again later.",
      );
    }
    await store.writeLockout({ subjectHash: subject, ...nextLockout(current, now) });
    const started = performance.now();
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const createdAt = now.toISOString();
    const actorId = await store.createMagicLinkForEmail({
      email: body.email,
      tokenHash: sha256(token),
      createdAt,
      expiresAt: new Date(now.getTime() + MAGIC_TTL_MS).toISOString(),
    });
    if (actorId) {
      const origin = deps.webOrigins[0] ?? "http://127.0.0.1:4317";
      void deps.email
        .send({
          to: body.email,
          subject: "Your Nexora sign-in link",
          text: `Sign in to Nexora: ${origin}/studio?magic=${token}\nThis link expires in 15 minutes and works once.`,
        })
        .catch((error: unknown) => {
          logger.error("email.magic_link", {
            requestId: c.get("requestId"),
            message: error instanceof Error ? error.message : "sign-in email was not sent",
          });
        });
    }
    await recordAuth(store, logger, {
      eventType: "magic_link_sent",
      outcome: actorId ? "success" : "failure",
      actorId,
      tenantId: null,
      requestId: c.get("requestId"),
    });
    await holdMagicResponse(started);
    return c.json(
      { message: "If an account exists for that address, a sign-in link was sent." },
      202,
    );
  });

  app.post("/auth/magic-link/consume", async (c) => {
    assertOrigin(c, deps.webOrigins);
    const body = consumeSchema.parse(await c.req.json());
    const region = deps.regionFor(body.region);
    const actorId = await store.consumeMagicLink(sha256(body.token), new Date().toISOString());
    if (!actorId) {
      await recordAuth(store, logger, {
        eventType: "magic_link_used",
        outcome: "failure",
        actorId: null,
        tenantId: null,
        requestId: c.get("requestId"),
      });
      throw new ApiError(
        401,
        "AUTH_INVALID_CREDENTIALS",
        "That sign-in link is invalid or expired.",
      );
    }
    const user = await store.findUser(actorId);
    if (!user || user.disabled) {
      throw new ApiError(
        401,
        "AUTH_INVALID_CREDENTIALS",
        "That sign-in link is invalid or expired.",
      );
    }
    if (user.email) await store.clearLockout(lockoutSubject("magic", user.email));
    const totp = await store.getTotp(actorId);
    if (totp?.enabled) {
      const challenge = await openChallenge(deps, actorId, region);
      await recordAuth(store, logger, {
        eventType: "magic_link_used",
        outcome: "success",
        actorId,
        tenantId: null,
        requestId: c.get("requestId"),
        payload: { mfa: "required" },
      });
      return c.json({ mfaRequired: true, challengeId: challenge }, 200);
    }
    await endPresentedSession(c, store, auth, logger);
    const session = await issueSession(c, store, auth, { actorId, region });
    await recordAuth(store, logger, {
      eventType: "magic_link_used",
      outcome: "success",
      actorId,
      tenantId: null,
      requestId: c.get("requestId"),
    });
    await recordAuth(store, logger, {
      eventType: "login_success",
      outcome: "success",
      actorId,
      tenantId: null,
      requestId: c.get("requestId"),
      payload: { method: "magic_link" },
    });
    return c.json(await sessionView(deps, actorId, null, region, session), 200);
  });

  app.post("/auth/2fa/enroll", async (c) => {
    const session = await requireActor(c, deps);
    const body = enrollSchema.parse(await c.req.json());
    const account = await store.findUser(session.actorId);
    await requirePassword(c, store, account, session.actorId, body.password);
    const secret = generateTotpSecret();
    const saved = await store.saveTotp({
      actorId: session.actorId,
      secretCipher: sealSecret(auth.secret, secret),
      createdAt: new Date().toISOString(),
    });
    if (saved === "locked") {
      throw new ApiError(409, "AUTH_TOTP_ENABLED", "Two-factor authentication is already enabled.");
    }
    const label = session.email ?? session.actorId;
    const otpauthUrl = totpAuthUrl("Nexora", label, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 192 });
    return c.json({ otpauthUrl, qrDataUrl, secret });
  });

  app.post("/auth/2fa/confirm", async (c) => {
    const session = await requireActor(c, deps);
    const body = confirmSchema.parse(await c.req.json());
    const totp = await store.getTotp(session.actorId);
    const secret = totp ? openSecret(auth.secret, totp.secretCipher) : null;
    if (!totp || totp.enabled || !secret || !verifyTotp(secret, body.code)) {
      await recordAuth(store, logger, {
        eventType: "totp_enroll",
        outcome: "failure",
        actorId: session.actorId,
        tenantId: session.tenantId,
        requestId: c.get("requestId"),
      });
      throw new ApiError(
        401,
        "AUTH_INVALID_CREDENTIALS",
        "That authenticator code was not accepted.",
      );
    }
    const enabled = await store.confirmTotp(session.actorId, new Date().toISOString());
    if (!enabled) {
      throw new ApiError(409, "AUTH_TOTP_ENABLED", "Two-factor authentication is already enabled.");
    }
    const recoveryCodes = generateRecoveryCodes();
    await store.saveRecoveryCodes(
      session.actorId,
      recoveryCodes.map((code) => hashRecoveryCode(code, auth.secret)),
    );
    await recordAuth(store, logger, {
      eventType: "totp_enroll",
      outcome: "success",
      actorId: session.actorId,
      tenantId: session.tenantId,
      requestId: c.get("requestId"),
    });
    return c.json({ recoveryCodes });
  });

  app.post("/auth/2fa/disable", async (c) => {
    const session = await requireActor(c, deps);
    const body = disableSchema.parse(await c.req.json());
    const account = await store.findUser(session.actorId);
    await requirePassword(c, store, account, session.actorId, body.password);
    const totp = await store.getTotp(session.actorId);
    const secret = totp?.enabled ? openSecret(auth.secret, totp.secretCipher) : null;
    if (!totp?.enabled || !secret || !verifyTotp(secret, body.code)) {
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "That sign-in code was not accepted.");
    }
    const disabled = await store.disableTotp(session.actorId, new Date().toISOString());
    if (!disabled) {
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "That sign-in code was not accepted.");
    }
    await recordAuth(store, logger, {
      eventType: "totp_enroll",
      outcome: "success",
      actorId: session.actorId,
      tenantId: session.tenantId,
      requestId: c.get("requestId"),
      payload: { action: "disabled" },
    });
    return c.json({ disabled: true });
  });

  app.post("/auth/2fa/verify", async (c) => {
    assertOrigin(c, deps.webOrigins);
    const body = verifySchema.parse(await c.req.json());
    const now = new Date();
    const challenge = await store.readMfaChallenge(body.challengeId);
    if (!challenge) {
      await recordAuth(store, logger, {
        eventType: "totp_verify",
        outcome: "failure",
        actorId: null,
        tenantId: null,
        requestId: c.get("requestId"),
      });
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "That sign-in code was not accepted.");
    }
    const subject = lockoutSubject("totp", challenge.actorId);
    const current = await store.readLockout(subject);
    const locked = lockoutStatus(current, now);
    if (locked.locked) {
      c.header("retry-after", String(locked.retryAfterSeconds));
      throw new ApiError(
        429,
        "AUTH_LOCKED",
        "Sign-in is temporarily unavailable. Try again later.",
      );
    }
    const totp = await store.getTotp(challenge.actorId);
    const secret = totp?.enabled ? openSecret(auth.secret, totp.secretCipher) : null;
    const step =
      body.code !== undefined && secret !== null ? matchingTotpStep(secret, body.code) : null;
    const codeOk = step !== null && (await store.acceptTotpStep(challenge.actorId, step));
    const recoveryOk =
      !codeOk && body.recoveryCode !== undefined
        ? await store.consumeRecoveryCode(
            challenge.actorId,
            hashRecoveryCode(body.recoveryCode, auth.secret),
            now.toISOString(),
          )
        : false;
    if (!codeOk && !recoveryOk) {
      await recordAuth(store, logger, {
        eventType: "totp_verify",
        outcome: "failure",
        actorId: challenge.actorId,
        tenantId: null,
        requestId: c.get("requestId"),
      });
      await store.writeLockout({ subjectHash: subject, ...nextLockout(current, now) });
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "That sign-in code was not accepted.");
    }
    const consumed = await store.consumeMfaChallenge(body.challengeId, now.toISOString());
    if (!consumed) {
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "That sign-in code was not accepted.");
    }
    await store.clearLockout(subject);
    const account = await store.findUser(challenge.actorId);
    await store.clearLockout(lockoutSubject("password", challenge.actorId));
    if (account?.email) await store.clearLockout(lockoutSubject("password", account.email));
    if (account?.email) await store.clearLockout(lockoutSubject("magic", account.email));
    await endPresentedSession(c, store, auth, logger);
    const session = await issueSession(c, store, auth, {
      actorId: challenge.actorId,
      region: challenge.region,
    });
    await recordAuth(store, logger, {
      eventType: "totp_verify",
      outcome: "success",
      actorId: challenge.actorId,
      tenantId: null,
      requestId: c.get("requestId"),
      payload: { method: recoveryOk ? "recovery" : "totp" },
    });
    await recordAuth(store, logger, {
      eventType: "login_success",
      outcome: "success",
      actorId: challenge.actorId,
      tenantId: null,
      requestId: c.get("requestId"),
      payload: { method: recoveryOk ? "recovery" : "totp" },
    });
    return c.json(await sessionView(deps, challenge.actorId, null, challenge.region, session), 200);
  });

  app.get("/auth/audit", async (c) => {
    const session = await requireActor(c, deps);
    const roles = session.tenantId ? await store.listRoles(session.tenantId, session.actorId) : [];
    const includeTenant = roles.includes("owner") || roles.includes("auditor");
    const events = await store.listAuthAudit({
      actorId: session.actorId,
      tenantId: session.tenantId,
      includeTenant,
    });
    return c.json({ events });
  });

  app.get("/auth/oidc/:provider/start", async (c) => {
    const provider = deps.oidcProviders.find((item) => item.id === c.req.param("provider"));
    if (!provider) {
      throw new ApiError(404, "AUTH_OIDC_UNKNOWN", "That sign-in provider is not configured.");
    }
    const start = startOidc(provider);
    const now = new Date();
    await store.saveOidcState({
      stateHash: start.stateHash,
      providerId: provider.id,
      nonceHash: start.nonceHash,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    });
    return c.redirect(start.authorizeUrl, 302);
  });

  app.get("/auth/oidc/:provider/callback", async (c) => {
    const provider = deps.oidcProviders.find((item) => item.id === c.req.param("provider"));
    if (!provider) {
      throw new ApiError(404, "AUTH_OIDC_UNKNOWN", "That sign-in provider is not configured.");
    }
    const state = c.req.query("state")?.trim() ?? "";
    const code = c.req.query("code")?.trim() ?? "";
    if (!state || !code) {
      throw new ApiError(
        400,
        "AUTH_OIDC_STATE",
        "The sign-in provider did not return a state and code.",
      );
    }
    const consumed = await store.consumeOidcState(sha256(state), new Date().toISOString());
    if (!consumed || consumed.providerId !== provider.id) {
      throw new ApiError(400, "AUTH_OIDC_STATE", "The sign-in state is invalid or expired.");
    }
    throw new ApiError(
      501,
      "AUTH_OIDC_NOT_COMPLETED",
      "The provider is configured, but token exchange is not enabled on this deployment.",
    );
  });

  if (deps.devMailbox) {
    const mailbox = deps.devMailbox;
    app.get("/auth/dev/mailbox", (c) => c.json({ messages: mailbox.list() }));
  }
}

function holdMagicResponse(started: number): Promise<void> {
  const remaining = MAGIC_RESPONSE_FLOOR_MS - (performance.now() - started);
  if (remaining <= 0) return Promise.resolve();
  const end = performance.now() + remaining;
  while (performance.now() < end) {
    // Busy wait. A timer would jitter by more than the timing bound.
  }
  return Promise.resolve();
}

async function requirePassword(
  c: AppContext,
  store: LedgerStore,
  account: AuthUserRecord | null,
  actorId: string,
  password: string,
): Promise<void> {
  const subjects = passwordSubjects(actorId, account?.email);
  const now = new Date();
  const states = await Promise.all(subjects.map((subject) => store.readLockout(subject)));
  const retry = lockedRetry(states, now);
  if (retry !== null) {
    c.header("retry-after", String(retry));
    throw new ApiError(429, "AUTH_LOCKED", "Sign-in is temporarily unavailable. Try again later.");
  }
  const valid =
    account !== null && !account.disabled && (await verifyPassword(password, account.passwordHash));
  if (!valid) {
    const snapshot = nextLockout(strictestLockout(states), now);
    await Promise.all(
      subjects.map((subjectHash) => store.writeLockout({ subjectHash, ...snapshot })),
    );
    throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Actor id or password is incorrect");
  }
  await Promise.all(subjects.map((subject) => store.clearLockout(subject)));
}

async function openChallenge(deps: FactorDeps, actorId: string, region: string): Promise<string> {
  const now = new Date();
  const locked = lockoutStatus(await deps.store.readLockout(lockoutSubject("totp", actorId)), now);
  if (locked.locked) {
    throw new ApiError(429, "AUTH_LOCKED", "Sign-in is temporarily unavailable. Try again later.");
  }
  const challengeId = crypto.randomUUID();
  await deps.store.createMfaChallenge({
    challengeId,
    actorId,
    region,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
  });
  return challengeId;
}

async function requireActor(c: AppContext, deps: FactorDeps) {
  const session = await lookupSession(c, deps.store, deps.auth);
  if (session.status !== "active") {
    clearSessionCookie(c, deps.auth);
    throw new ApiError(401, "AUTH_UNAUTHENTICATED", "Sign in to continue");
  }
  assertCsrf(c, deps.auth, deps.webOrigins, session.identity.sessionId);
  const user = await deps.store.findUser(session.identity.actorId);
  return {
    actorId: session.identity.actorId,
    tenantId: session.identity.tenantId,
    region: session.identity.region,
    email: user?.email ?? null,
  };
}

async function sessionView(
  deps: FactorDeps,
  actorId: string,
  tenantId: string | null,
  region: string,
  session: { sessionId: string; expiresAt: string; csrfToken: string },
) {
  const roles = tenantId ? await deps.store.listRoles(tenantId, actorId) : [];
  return {
    actorId,
    tenantId,
    region,
    roles,
    platformAdmin: deps.platformAdminActorIds.includes(actorId),
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  };
}

export { openChallenge };
