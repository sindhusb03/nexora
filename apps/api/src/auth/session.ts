import { runWithRlsSession, type IdentityStore, type LedgerStore } from "@nexora/db";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { AuthConfig } from "../config.js";
import { ApiError, type AppContext, type AppEnv, type Identity } from "../http.js";
import { csrfTokenMatches, readSignedSessionId, signSessionId } from "./crypto.js";
import { enforceSupportExpiry } from "./support-expiry.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function sessionCookieName(auth: AuthConfig): string {
  return auth.cookieSecure ? "__Host-nexora_session" : "nexora_session";
}

export function writeSessionCookie(c: AppContext, auth: AuthConfig, sessionId: string): void {
  setCookie(c, sessionCookieName(auth), signSessionId(auth.secret, sessionId), {
    httpOnly: true,
    secure: auth.cookieSecure,
    sameSite: auth.cookieSameSite,
    path: "/",
    maxAge: auth.sessionTtlSeconds,
  });
}

export function clearSessionCookie(c: AppContext, auth: AuthConfig): void {
  deleteCookie(c, sessionCookieName(auth), { path: "/", secure: auth.cookieSecure });
}

export type SessionLookup =
  | { readonly status: "none" }
  | { readonly status: "invalid" }
  | { readonly status: "active"; readonly identity: Identity & { readonly sessionId: string } };

/** Reads the session cookie. A present but forged, expired, or revoked cookie is "invalid", never a fallback to headers. */
export async function lookupSession(
  c: AppContext,
  store: IdentityStore,
  auth: AuthConfig,
): Promise<SessionLookup> {
  const cookie = getCookie(c, sessionCookieName(auth));
  if (!cookie) return { status: "none" };
  const sessionId = readSignedSessionId(auth.secret, cookie);
  if (!sessionId) return { status: "invalid" };
  const state = await store.sessionState(sessionId);
  if (state === "revoked") {
    await store.revokeSessionFamily(sessionId, new Date().toISOString());
    return { status: "invalid" };
  }
  if (state !== "active") return { status: "invalid" };
  const session = await store.getActiveSession(sessionId);
  if (!session) return { status: "invalid" };
  return {
    status: "active",
    identity: {
      actorId: session.actorId,
      tenantId: session.tenantId,
      region: session.region,
      source: "session",
      sessionId: session.sessionId,
    },
  };
}

/** Rejects a browser Origin that is not on the allow-list. A missing Origin is allowed for non-browser clients. */
export function assertOrigin(c: AppContext, webOrigins: readonly string[]): void {
  const origin = c.req.header("origin");
  if (origin && !webOrigins.includes(origin)) {
    throw new ApiError(403, "AUTH_ORIGIN_REJECTED", "Request origin is not allowed");
  }
}

/** Cookie-authenticated writes must echo the session's CSRF token and, when the browser sends one, an allowed Origin. */
export function assertCsrf(
  c: AppContext,
  auth: AuthConfig,
  webOrigins: readonly string[],
  sessionId: string,
): void {
  if (SAFE_METHODS.has(c.req.method)) return;
  assertOrigin(c, webOrigins);
  const token = c.req.header("x-csrf-token")?.trim() ?? "";
  if (token.length === 0 || !csrfTokenMatches(auth.secret, sessionId, token)) {
    throw new ApiError(
      403,
      "AUTH_CSRF_FAILED",
      "Missing or invalid x-csrf-token for a cookie-authenticated write",
    );
  }
}

function devHeaderIdentity(c: AppContext): Identity | null {
  const actorId = c.req.header("x-actor-id")?.trim() ?? "";
  if (actorId.length === 0) return null;
  const tenantId = c.req.header("x-tenant-id")?.trim() ?? "";
  return {
    actorId,
    tenantId: tenantId.length > 0 ? tenantId : null,
    region: c.req.header("x-region")?.trim() ?? "",
    source: "dev-headers",
    sessionId: null,
  };
}

/** Every /v1 route passes through here. No verified identity means 401 before any handler runs. */
export function requireIdentity(deps: {
  readonly store: LedgerStore;
  readonly auth: AuthConfig;
  readonly webOrigins: readonly string[];
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const session = await lookupSession(c, deps.store, deps.auth);
    if (session.status === "invalid") {
      clearSessionCookie(c, deps.auth);
      throw new ApiError(
        401,
        "AUTH_SESSION_INVALID",
        "The session is expired, revoked, or not recognised; sign in again",
      );
    }
    let identity: Identity | null = null;
    if (session.status === "active") {
      assertCsrf(c, deps.auth, deps.webOrigins, session.identity.sessionId);
      identity = session.identity;
    } else if (deps.auth.devHeaders) {
      identity = devHeaderIdentity(c);
    }
    if (!identity) {
      throw new ApiError(401, "AUTH_UNAUTHENTICATED", "Sign in to continue");
    }
    if (
      identity.tenantId &&
      (await enforceSupportExpiry(
        deps.store,
        identity.tenantId,
        identity.actorId,
        c.get("requestId"),
      )) === "expired"
    ) {
      if (identity.sessionId) await deps.store.selectSessionTenant(identity.sessionId, null);
      throw new ApiError(
        403,
        "AUTH_SUPPORT_EXPIRED",
        "Support access has expired; choose another company",
      );
    }
    c.set("identity", identity);
    await runWithRlsSession({ actorId: identity.actorId, tenantId: identity.tenantId }, () =>
      next(),
    );
  };
}
