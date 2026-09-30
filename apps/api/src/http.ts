import type { KernelErrorCode } from "@nexora/kernel";
import type { Context } from "hono";

/** Who is calling. Produced only by the identity middleware from a verified session (or dev headers when enabled). */
export interface Identity {
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly region: string;
  readonly source: "session" | "dev-headers";
  readonly sessionId: string | null;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    identity: Identity | null;
  };
}

export type AppContext = Context<AppEnv>;

export interface ActorContext {
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly region: string;
  readonly correlationId: string;
  readonly idempotencyKey: string | null;
  readonly expectedVersion: number | null;
  /** True when the actor was authenticated by a signed session rather than development headers. */
  readonly verified: boolean;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503;

/** Failures outside the kernel's vocabulary: authentication, CSRF, limits. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function readActor(c: AppContext): ActorContext {
  const identity = c.get("identity");
  if (!identity) {
    throw new ApiError(401, "AUTH_UNAUTHENTICATED", "Sign in to continue");
  }
  const correlationHeader = c.req.header("x-correlation-id")?.trim() ?? "";
  const correlationId = CORRELATION_ID.test(correlationHeader)
    ? correlationHeader
    : c.get("requestId");
  const idempotencyKey = c.req.header("idempotency-key")?.trim() || null;
  const expectedHeader = c.req.header("expected-version")?.trim();
  const expectedVersion = expectedHeader ? Number(expectedHeader) : null;
  return {
    actorId: identity.actorId,
    tenantId: identity.tenantId,
    region: identity.region,
    correlationId,
    idempotencyKey,
    expectedVersion: Number.isInteger(expectedVersion) ? expectedVersion : null,
    verified: identity.source === "session",
  };
}

export function statusFor(code: KernelErrorCode): 400 | 403 | 404 | 409 | 422 {
  switch (code) {
    case "AUTH_SCOPE_DENIED":
    case "REGION_MISMATCH":
    case "TENANT_SUSPENDED":
    case "TENANT_ISOLATION":
      return 403;
    case "FIN_NOT_FOUND":
      return 404;
    case "FIN_VERSION_CONFLICT":
    case "FIN_IDEMPOTENCY_MISMATCH":
    case "FIN_OVERLAPPING_PERIOD":
    case "FIN_PERIOD_CLOSED":
    case "FIN_IMMUTABLE_RECORD":
    case "PUBLISH_BLOCKED":
      return 409;
    case "FIN_UNBALANCED_JOURNAL":
    case "FIN_STATEMENT_IMBALANCE":
    case "FIN_INVALID_JOURNAL_LINE":
      return 422;
    default:
      return 400;
  }
}
