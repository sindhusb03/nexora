import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { ApiError, type AppContext, type AppEnv } from "./http.js";

export interface RateLimitOptions {
  readonly name: string;
  readonly windowMs: number;
  readonly max: number;
  readonly trustProxy: boolean;
  /** Rightmost hops appended by our own proxies. Ignored unless trustProxy is set. */
  readonly trustedHops?: number;
  /** Credential routes accept JSON only, so a text/plain body cannot skip the account key. */
  readonly jsonOnly?: boolean;
  readonly now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

const AUTH_BODY_LIMIT_BYTES = 16 * 1024;
type AccountCheck = (accounts: readonly string[]) => Response | undefined;
// Credential middleware precedes the general limiter in app.ts. Defer account work so
// both IP buckets decide before any body read. Weak keys keep state request-local.
const credentialChecks = new WeakMap<AppContext, AccountCheck>();

/**
 * Fixed-window limit per client address. State is per process: behind several API instances
 * each instance enforces its own window, so the effective limit is max × instances.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, Window>();
  const now = options.now ?? Date.now;
  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const at = now();
    if (windows.size > 10_000) {
      for (const [key, window] of windows) {
        if (window.resetAt <= at) windows.delete(key);
      }
    }
    const touch = (key: string) => {
      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        window = { count: 0, resetAt: at + options.windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return window;
    };
    const check = (touched: readonly Window[]) => {
      const tightest = touched.reduce((left, right) => (left.count >= right.count ? left : right));
      const remaining = Math.max(0, options.max - tightest.count);
      const resetSeconds = Math.max(1, Math.ceil((tightest.resetAt - at) / 1000));
      c.header("ratelimit-limit", String(options.max));
      c.header("ratelimit-remaining", String(remaining));
      c.header("ratelimit-reset", String(resetSeconds));
      if (tightest.count > options.max) {
        c.header("retry-after", String(resetSeconds));
        return c.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: `Too many ${options.name} requests; retry after ${resetSeconds}s`,
            },
          },
          429,
        );
      }
      return undefined;
    };
    const ip = touch(`ip:${clientAddress(c, options.trustProxy, options.trustedHops ?? 1)}`);
    const blocked = check([ip]);
    if (blocked) return blocked;
    if (options.jsonOnly) {
      credentialChecks.set(c, (accounts) =>
        check([ip, ...accounts.map((account) => touch(`acct:${account}`))]),
      );
      try {
        await next();
      } finally {
        credentialChecks.delete(c);
      }
      return;
    }
    const credentialCheck = credentialChecks.get(c);
    if (credentialCheck) {
      const accounts = await accountIdentifiers(c);
      const credentialBlocked = credentialCheck(accounts);
      if (credentialBlocked) return credentialBlocked;
      const accountBlocked = check([ip, ...accounts.map((account) => touch(`acct:${account}`))]);
      if (accountBlocked) return accountBlocked;
    }
    await next();
  };
}

/**
 * Client address for rate limits.
 * With trustProxy, the rightmost `trustedHops` entries were appended by our proxies
 * (the ALB appends the peer it saw). The address is the entry just before those hops.
 * A client-supplied leftmost value is ignored. Fewer entries than trusted hops means the
 * header is incomplete, so the socket address is used.
 * A single entry is trusted only because the task security group accepts traffic from
 * the load balancer alone, so that entry is the one the balancer appended.
 */
export function clientAddress(c: AppContext, trustProxy: boolean, trustedHops = 1): string {
  if (trustProxy) {
    const forwarded = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const hops = Math.max(1, trustedHops);
    if (forwarded.length >= hops) {
      return forwarded[forwarded.length - hops] ?? "unknown";
    }
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "local";
  }
}

/** Type and subtype only, so a parameter cannot smuggle application/json. */
function isJsonContentType(header: string | undefined): boolean {
  const media = (header ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    media === "application/json" || (media.startsWith("application/") && media.endsWith("+json"))
  );
}

async function accountIdentifiers(c: AppContext): Promise<readonly string[]> {
  if (c.req.method === "GET" || c.req.method === "OPTIONS" || c.req.method === "HEAD") return [];
  if (!isJsonContentType(c.req.header("content-type"))) {
    throw new HTTPException(415, {
      res: c.json(
        { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send application/json" } },
        415,
      ),
    });
  }
  const length = c.req.header("content-length");
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > AUTH_BODY_LIMIT_BYTES)) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Credential body exceeds ${AUTH_BODY_LIMIT_BYTES} bytes`,
    );
  }
  // Missing lengths and chunked bodies are accepted only through this bounded reader.
  // Enforce actual bytes even when a client understates Content-Length.
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AUTH_BODY_LIMIT_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new ApiError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Credential body exceeds ${AUTH_BODY_LIMIT_BYTES} bytes`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Preserve the bounded body for downstream bodyLimit (including smaller configured limits).
  c.req.raw = new Request(c.req.raw, { body: bytes });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiError(400, "VALIDATION_FAILED", "Request body must be valid JSON");
    }
    throw error;
  }
  // This Hono version caches text, but json() reparses it. Cache the parsed value too.
  c.req.json = async <T>() => body as T;
  if (typeof body !== "object" || body === null) return [];
  const record = body as { actorId?: unknown; email?: unknown };
  const raw = [record.actorId, record.email].filter((value): value is string => {
    return typeof value === "string" && value.length > 0 && value.length <= 320;
  });
  return [...new Set(raw.map((value) => value.normalize("NFKC").trim().toLowerCase()))].filter(
    (value) => value.length > 0,
  );
}
