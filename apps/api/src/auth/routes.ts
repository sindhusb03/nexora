import { assertSameRegion, assertTenantActive, KernelError } from "@nexora/kernel";
import type { LedgerStore } from "@nexora/db";
import type { Hono } from "hono";
import { z } from "zod";

import type { AuthConfig } from "../config.js";
import { ApiError, type AppContext, type AppEnv, type Identity } from "../http.js";
import type { Logger } from "../observability.js";
import { DEMO_REGION } from "../demo/seed.js";
import { enforceSupportExpiry } from "./support-expiry.js";
import { burnPasswordCheck, csrfTokenFor, hashPassword, verifyPassword } from "./crypto.js";
import type { EmailSender, MemoryMailbox } from "./email.js";
import { openChallenge, registerFactorRoutes } from "./factors.js";
import { endPresentedSession, issueSession, recordAuth } from "./issue.js";
import {
  lockedRetry,
  lockoutSubject,
  nextLockout,
  passwordSubjects,
  strictestLockout,
} from "./lockout.js";
import type { OidcProviderConfig } from "./oidc.js";
import {
  assertCsrf,
  assertOrigin,
  clearSessionCookie,
  lookupSession,
  writeSessionCookie,
} from "./session.js";

export const ACTOR_ID = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const RESERVED_ACTOR_IDS = new Set([
  "admin",
  "administrator",
  "platform-admin",
  "root",
  "support",
  "system",
  "nexora",
]);

const actorIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ACTOR_ID, "Actor id is 1–64 lowercase letters, digits, dot, dash, or underscore");
const passwordSchema = z.string().min(12, "Password must be at least 12 characters").max(256);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a valid email address");
const signupSchema = z.object({
  actorId: actorIdSchema,
  password: passwordSchema,
  email: emailSchema.optional(),
});
const loginSchema = z
  .object({
    actorId: actorIdSchema.optional(),
    email: emailSchema.optional(),
    password: z.string().min(1).max(256),
    region: z.string().trim().regex(REGION).optional(),
  })
  .refine((value) => value.actorId !== undefined || value.email !== undefined, {
    message: "Actor id or email is required",
  });
const tenantSelectionSchema = z.object({ tenantId: z.uuid().nullable() });

export interface AuthRouteDeps {
  readonly store: LedgerStore;
  readonly auth: AuthConfig;
  readonly webOrigins: readonly string[];
  readonly platformAdminActorIds: readonly string[];
  readonly logger: Logger;
  readonly passwordCost?: number;
  readonly demoMode?: boolean;
  readonly email?: EmailSender;
  readonly devMailbox?: MemoryMailbox | null;
  readonly oidcProviders?: readonly OidcProviderConfig[];
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRouteDeps): void {
  const { store, auth, logger } = deps;

  app.get("/auth/config", (c) =>
    c.json({
      signupAllowed: auth.allowSignup,
      pinnedRegion: auth.pinnedRegion,
      region: auth.pinnedRegion ?? (deps.demoMode ? DEMO_REGION : null),
      sessionTtlSeconds: auth.sessionTtlSeconds,
      demoMode: deps.demoMode ?? false,
      oidcProviders: (deps.oidcProviders ?? []).map((provider) => ({
        id: provider.id,
        label: provider.label,
      })),
    }),
  );

  registerFactorRoutes(app, {
    store,
    auth,
    webOrigins: deps.webOrigins,
    logger,
    email: deps.email ?? {
      async send() {
        return undefined;
      },
    },
    devMailbox: deps.devMailbox ?? null,
    oidcProviders: deps.oidcProviders ?? [],
    platformAdminActorIds: deps.platformAdminActorIds,
    regionFor: (requested) => resolveRegion(auth, requested),
  });

  app.post("/auth/signup", async (c) => {
    assertOrigin(c, deps.webOrigins);
    if (!auth.allowSignup) {
      throw new ApiError(
        403,
        "AUTH_SIGNUP_DISABLED",
        "Self sign-up is disabled on this deployment; an operator creates accounts",
      );
    }
    const body = signupSchema.parse(await c.req.json());
    if (
      RESERVED_ACTOR_IDS.has(body.actorId) ||
      deps.platformAdminActorIds.some((actorId) => actorId.trim().toLowerCase() === body.actorId)
    ) {
      throw new ApiError(409, "AUTH_ACTOR_TAKEN", "That account could not be created");
    }
    const outcome = await store.createUser({
      actorId: body.actorId,
      passwordHash: await hashPassword(body.password, deps.passwordCost),
      createdAt: new Date().toISOString(),
      ...(body.email ? { email: body.email } : {}),
    });
    if (outcome !== "created") {
      throw new ApiError(409, "AUTH_ACTOR_TAKEN", "That account could not be created");
    }
    logger.info("auth.signup", { requestId: c.get("requestId"), actorId: body.actorId });
    return c.json({ actorId: body.actorId }, 201);
  });

  app.post("/auth/login", async (c) => {
    assertOrigin(c, deps.webOrigins);
    const body = loginSchema.parse(await c.req.json());
    const region = resolveRegion(auth, body.region);
    const identifier = body.actorId ?? body.email ?? "";
    const user = body.actorId
      ? await store.findUser(body.actorId)
      : await store.findUserByEmail(body.email ?? "");
    const subjects = [
      ...new Set([
        lockoutSubject("password", identifier),
        ...(user ? passwordSubjects(user.actorId, user.email) : []),
      ]),
    ];
    const now = new Date();
    const states = await Promise.all(subjects.map((subject) => store.readLockout(subject)));
    const retry = lockedRetry(states, now);
    if (retry !== null) {
      c.header("retry-after", String(retry));
      throw new ApiError(
        429,
        "AUTH_LOCKED",
        "Sign-in is temporarily unavailable. Try again later.",
      );
    }
    const valid =
      user && !user.disabled
        ? await verifyPassword(body.password, user.passwordHash)
        : await burnPasswordCheck(body.password, deps.passwordCost);
    if (!valid || !user) {
      const snapshot = nextLockout(strictestLockout(states), now);
      await Promise.all(
        subjects.map((subjectHash) => store.writeLockout({ subjectHash, ...snapshot })),
      );
      await recordAuth(store, logger, {
        eventType: "login_failure",
        outcome: "failure",
        actorId: user?.actorId ?? null,
        tenantId: null,
        requestId: c.get("requestId"),
        payload: { method: "password" },
      });
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Actor id or password is incorrect");
    }
    const totp = await store.getTotp(user.actorId);
    if (totp?.enabled) {
      const challengeId = await openChallenge(
        {
          store,
          auth,
          webOrigins: deps.webOrigins,
          logger,
          email: deps.email ?? {
            async send() {
              return undefined;
            },
          },
          devMailbox: null,
          oidcProviders: deps.oidcProviders ?? [],
          platformAdminActorIds: deps.platformAdminActorIds,
          regionFor: (requested) => resolveRegion(auth, requested),
        },
        user.actorId,
        region,
      );
      return c.json({ mfaRequired: true, challengeId }, 200);
    }

    await Promise.all(subjects.map((subject) => store.clearLockout(subject)));
    await endPresentedSession(c, store, auth, logger);
    const session = await issueSession(c, store, auth, { actorId: user.actorId, region });
    await recordAuth(store, logger, {
      eventType: "login_success",
      outcome: "success",
      actorId: user.actorId,
      tenantId: null,
      requestId: c.get("requestId"),
      payload: { method: "password" },
    });
    return c.json(
      await view(
        deps,
        {
          actorId: user.actorId,
          tenantId: null,
          region,
          source: "session",
          sessionId: session.sessionId,
        },
        session.expiresAt,
      ),
      200,
    );
  });

  app.post("/auth/logout", async (c) => {
    const session = await lookupSession(c, store, auth);
    if (session.status === "active") {
      assertCsrf(c, auth, deps.webOrigins, session.identity.sessionId);
      await store.revokeSession(session.identity.sessionId, new Date().toISOString());
      await recordAuth(store, logger, {
        eventType: "session_revoke",
        outcome: "success",
        actorId: session.identity.actorId,
        tenantId: session.identity.tenantId,
        requestId: c.get("requestId"),
        payload: { reason: "logout" },
      });
    }
    clearSessionCookie(c, auth);
    return c.body(null, 204);
  });

  app.get("/auth/session", async (c) => {
    const session = await requireSession(c, deps);
    const record = await store.getActiveSession(session.sessionId);
    return c.json(await view(deps, session, record?.expiresAt ?? null));
  });

  app.post("/auth/session/tenant", async (c) => {
    const session = await requireSession(c, deps);
    assertCsrf(c, auth, deps.webOrigins, session.sessionId);
    const body = tenantSelectionSchema.parse(await c.req.json());
    if (body.tenantId !== null) {
      if (
        (await enforceSupportExpiry(store, body.tenantId, session.actorId, c.get("requestId"))) ===
        "expired"
      ) {
        throw new ApiError(
          403,
          "AUTH_SUPPORT_EXPIRED",
          "Support access has expired; choose another company",
        );
      }
      const tenant = await store.getTenant(body.tenantId);
      if (!tenant) {
        throw new KernelError("FIN_NOT_FOUND", "Tenant not found");
      }
      assertSameRegion(tenant.homeRegion, session.region);
      assertTenantActive(tenant.status);
      const roles = await store.listRoles(tenant.tenantId, session.actorId);
      if (roles.length === 0) {
        throw new KernelError("AUTH_SCOPE_DENIED", "Actor has no membership in this tenant");
      }
    }
    const now = new Date();
    const nextSessionId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + auth.sessionTtlSeconds * 1000).toISOString();
    const rotated = await store.rotateSession({
      sessionId: session.sessionId,
      nextSessionId,
      now: now.toISOString(),
      expiresAt,
    });
    if (!rotated || !(await store.selectSessionTenant(nextSessionId, body.tenantId))) {
      clearSessionCookie(c, auth);
      throw new ApiError(
        401,
        "AUTH_SESSION_INVALID",
        "The session is expired or revoked; sign in again",
      );
    }
    writeSessionCookie(c, auth, nextSessionId);
    logger.info("auth.tenant_selected", {
      requestId: c.get("requestId"),
      actorId: session.actorId,
      tenantId: body.tenantId,
    });
    return c.json(
      await view(
        deps,
        { ...session, tenantId: body.tenantId, sessionId: nextSessionId },
        expiresAt,
      ),
    );
  });

  app.post("/auth/session/rotate", async (c) => {
    const session = await requireSession(c, deps);
    assertCsrf(c, auth, deps.webOrigins, session.sessionId);
    const now = new Date();
    const nextSessionId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + auth.sessionTtlSeconds * 1000).toISOString();
    const rotated = await store.rotateSession({
      sessionId: session.sessionId,
      nextSessionId,
      now: now.toISOString(),
      expiresAt,
    });
    if (!rotated) {
      clearSessionCookie(c, auth);
      throw new ApiError(
        401,
        "AUTH_SESSION_INVALID",
        "The session is expired or revoked; sign in again",
      );
    }
    writeSessionCookie(c, auth, nextSessionId);
    await recordAuth(store, logger, {
      eventType: "session_revoke",
      outcome: "success",
      actorId: session.actorId,
      tenantId: session.tenantId,
      requestId: c.get("requestId"),
      payload: { reason: "rotated" },
    });
    return c.json(await view(deps, { ...session, sessionId: nextSessionId }, expiresAt));
  });
}

function resolveRegion(auth: AuthConfig, requested: string | undefined): string {
  const region = requested ?? auth.pinnedRegion;
  if (!region) {
    throw new ApiError(400, "VALIDATION_FAILED", "Region is required");
  }
  if (auth.pinnedRegion && region !== auth.pinnedRegion) {
    throw new KernelError("REGION_MISMATCH", `This deployment serves ${auth.pinnedRegion}`);
  }
  return region;
}

async function requireSession(
  c: AppContext,
  deps: AuthRouteDeps,
): Promise<Identity & { readonly sessionId: string }> {
  const session = await lookupSession(c, deps.store, deps.auth);
  if (session.status === "invalid") {
    clearSessionCookie(c, deps.auth);
    throw new ApiError(
      401,
      "AUTH_SESSION_INVALID",
      "The session is expired, revoked, or not recognised; sign in again",
    );
  }
  if (session.status === "none") {
    throw new ApiError(401, "AUTH_UNAUTHENTICATED", "Sign in to continue");
  }
  if (
    session.identity.tenantId &&
    (await enforceSupportExpiry(
      deps.store,
      session.identity.tenantId,
      session.identity.actorId,
      c.get("requestId"),
    )) === "expired"
  ) {
    assertCsrf(c, deps.auth, deps.webOrigins, session.identity.sessionId);
    await deps.store.selectSessionTenant(session.identity.sessionId, null);
    throw new ApiError(
      403,
      "AUTH_SUPPORT_EXPIRED",
      "Support access has expired; choose another company",
    );
  }
  c.set("identity", session.identity);
  return session.identity;
}

async function view(
  deps: AuthRouteDeps,
  session: Identity & { readonly sessionId: string },
  expiresAt: string | null,
) {
  const roles = session.tenantId
    ? await deps.store.listRoles(session.tenantId, session.actorId)
    : [];
  return {
    actorId: session.actorId,
    tenantId: session.tenantId,
    region: session.region,
    roles,
    platformAdmin: deps.platformAdminActorIds.includes(session.actorId),
    expiresAt,
    csrfToken: csrfTokenFor(deps.auth.secret, session.sessionId),
  };
}
