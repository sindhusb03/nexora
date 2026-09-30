import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";

import type { AppContext, AppEnv } from "./http.js";

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
    const keys = [`ip:${clientAddress(c, options.trustProxy, options.trustedHops ?? 1)}`];
    for (const account of await accountIdentifiers(c)) keys.push(`acct:${account}`);
    const touched = keys.map((key) => {
      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        window = { count: 0, resetAt: at + options.windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return window;
    });
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
    if (
      options.jsonOnly &&
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.method !== "OPTIONS" &&
      !isJsonContentType(c.req.header("content-type"))
    ) {
      return c.json(
        { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send application/json" } },
        415,
      );
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
  if (!isJsonContentType(c.req.header("content-type"))) return [];
  try {
    const body = (await c.req.raw.clone().json()) as unknown;
    if (typeof body !== "object" || body === null) return [];
    const record = body as { actorId?: unknown; email?: unknown };
    const raw = [record.actorId, record.email].filter((value): value is string => {
      return typeof value === "string" && value.length > 0 && value.length <= 320;
    });
    return [...new Set(raw.map((value) => value.normalize("NFKC").trim().toLowerCase()))].filter(
      (value) => value.length > 0,
    );
  } catch {
    return [];
  }
}
