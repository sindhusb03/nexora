import { assertSameRegion, assertTenantActive, KernelError } from "@nexora/kernel";
import type { LedgerStore } from "@nexora/db";
import type { Hono } from "hono";
import { z } from "zod";

import type { AuthConfig } from "../config.js";
import { ApiError, type AppContext, type AppEnv, type Identity } from "../http.js";
import type { Logger } from "../observability.js";
import { expireSupportGrants } from "../workspace/routes.js";
import { burnPasswordCheck, csrfTokenFor, hashPassword, verifyPassword } from "./crypto.js";
import { assertCsrf, clearSessionCookie, lookupSession, writeSessionCookie } from "./session.js";

export const ACTOR_ID = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

const actorIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ACTOR_ID, "Actor id is 1–64 lowercase letters, digits, dot, dash, or underscore");
const passwordSchema = z.string().min(12, "Password must be at least 12 characters").max(256);

const signupSchema = z.object({ actorId: actorIdSchema, password: passwordSchema });
const loginSchema = z.object({
  actorId: actorIdSchema,
  password: z.string().min(1).max(256),
  region: z.string().trim().regex(REGION).optional(),
});
const tenantSelectionSchema = z.object({ tenantId: z.uuid().nullable() });

export interface AuthRouteDeps {
  readonly store: LedgerStore;
  readonly auth: AuthConfig;
  readonly webOrigins: readonly string[];
  readonly platformAdminActorIds: readonly string[];
  readonly logger: Logger;
  readonly passwordCost?: number;
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRouteDeps): void {
  const { store, auth, logger } = deps;

  app.get("/auth/config", (c) =>
    c.json({ signupAllowed: auth.allowSignup, pinnedRegion: auth.pinnedRegion, sessionTtlSeconds: auth.sessionTtlSeconds }),
  );

  app.post("/auth/signup", async (c) => {
    if (!auth.allowSignup) {
      throw new ApiError(403, "AUTH_SIGNUP_DISABLED", "Self sign-up is disabled on this deployment; an operator creates accounts");
    }
    const body = signupSchema.parse(await c.req.json());
    const outcome = await store.createUser({
      actorId: body.actorId,
      passwordHash: await hashPassword(body.password, deps.passwordCost),
      createdAt: new Date().toISOString(),
    });
    if (outcome === "exists") {
      throw new ApiError(409, "AUTH_ACTOR_TAKEN", "That actor id is already registered");
    }
    logger.info("auth.signup", { requestId: c.get("requestId"), actorId: body.actorId });
    return c.json({ actorId: body.actorId }, 201);
  });

  app.post("/auth/login", async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const region = body.region ?? auth.pinnedRegion;
    if (!region) {
      throw new ApiError(400, "VALIDATION_FAILED", "Region is required");
    }
    if (auth.pinnedRegion && region !== auth.pinnedRegion) {
      throw new KernelError("REGION_MISMATCH", `This deployment serves ${auth.pinnedRegion}`);
    }
    const user = await store.findUser(body.actorId);
    const valid =
      user && !user.disabled
        ? await verifyPassword(body.password, user.passwordHash)
        : await burnPasswordCheck(body.password, deps.passwordCost);
    if (!valid) {
      logger.warn("auth.login_failed", { requestId: c.get("requestId"), actorId: body.actorId });
      throw new ApiError(401, "AUTH_INVALID_CREDENTIALS", "Actor id or password is incorrect");
    }

    const previous = await lookupSession(c, store, auth);
    if (previous.status === "active") {
      await store.revokeSession(previous.identity.sessionId, new Date().toISOString());
    }
    const now = new Date();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + auth.sessionTtlSeconds * 1000).toISOString();
    await store.createSession({ sessionId, actorId: body.actorId, region, createdAt: now.toISOString(), expiresAt });
    writeSessionCookie(c, auth, sessionId);
    logger.info("auth.login", { requestId: c.get("requestId"), actorId: body.actorId, region });
    return c.json(
      await view(deps, { actorId: body.actorId, tenantId: null, region, source: "session", sessionId }, expiresAt),
      200,
    );
  });

  app.post("/auth/logout", async (c) => {
    const session = await lookupSession(c, store, auth);
    if (session.status === "active") {
      assertCsrf(c, auth, deps.webOrigins, session.identity.sessionId);
      await store.revokeSession(session.identity.sessionId, new Date().toISOString());
      logger.info("auth.logout", { requestId: c.get("requestId"), actorId: session.identity.actorId });
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
      await expireSupportGrants(store, body.tenantId, session.actorId, c.get("requestId"));
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
    if (!(await store.selectSessionTenant(session.sessionId, body.tenantId))) {
      clearSessionCookie(c, auth);
      throw new ApiError(401, "AUTH_SESSION_INVALID", "The session is expired or revoked; sign in again");
    }
    logger.info("auth.tenant_selected", { requestId: c.get("requestId"), actorId: session.actorId, tenantId: body.tenantId });
    const record = await store.getActiveSession(session.sessionId);
    return c.json(await view(deps, { ...session, tenantId: body.tenantId }, record?.expiresAt ?? null));
  });
}

async function requireSession(c: AppContext, deps: AuthRouteDeps): Promise<Identity & { readonly sessionId: string }> {
  const session = await lookupSession(c, deps.store, deps.auth);
  if (session.status === "invalid") {
    clearSessionCookie(c, deps.auth);
    throw new ApiError(401, "AUTH_SESSION_INVALID", "The session is expired, revoked, or not recognised; sign in again");
  }
  if (session.status === "none") {
    throw new ApiError(401, "AUTH_UNAUTHENTICATED", "Sign in to continue");
  }
  c.set("identity", session.identity);
  return session.identity;
}

async function view(deps: AuthRouteDeps, session: Identity & { readonly sessionId: string }, expiresAt: string | null) {
  const roles = session.tenantId ? await deps.store.listRoles(session.tenantId, session.actorId) : [];
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
