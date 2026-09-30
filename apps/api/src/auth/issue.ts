import type { AuthAuditEventType, LedgerStore } from "@nexora/db";

import type { AuthConfig } from "../config.js";
import type { AppContext } from "../http.js";
import type { Logger } from "../observability.js";
import { csrfTokenFor } from "./crypto.js";
import { writeSessionCookie } from "./session.js";

export async function issueSession(
  c: AppContext,
  store: LedgerStore,
  auth: AuthConfig,
  input: {
    readonly actorId: string;
    readonly region: string;
    readonly tenantId?: string | null;
  },
): Promise<{ sessionId: string; expiresAt: string; csrfToken: string }> {
  const now = new Date();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + auth.sessionTtlSeconds * 1000).toISOString();
  await store.createSession({
    sessionId,
    actorId: input.actorId,
    region: input.region,
    createdAt: now.toISOString(),
    expiresAt,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  });
  writeSessionCookie(c, auth, sessionId);
  return { sessionId, expiresAt, csrfToken: csrfTokenFor(auth.secret, sessionId) };
}

export async function recordAuth(
  store: LedgerStore,
  logger: Logger,
  input: {
    readonly eventType: AuthAuditEventType;
    readonly outcome: "success" | "failure";
    readonly actorId: string | null;
    readonly tenantId: string | null;
    readonly requestId: string;
    readonly payload?: Record<string, string>;
  },
): Promise<void> {
  await store.insertAuthAudit({
    eventId: crypto.randomUUID(),
    eventType: input.eventType,
    occurredAt: new Date().toISOString(),
    actorId: input.actorId,
    tenantId: input.tenantId,
    requestId: input.requestId,
    outcome: input.outcome,
    payload: input.payload ?? {},
  });
  const level = input.outcome === "success" ? "info" : "warn";
  logger[level](`auth.${input.eventType}`, {
    requestId: input.requestId,
    actorId: input.actorId,
    tenantId: input.tenantId,
    outcome: input.outcome,
  });
}
