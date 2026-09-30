import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";

import type { AppContext, AppEnv } from "./http.js";

export interface RateLimitOptions {
  readonly name: string;
  readonly windowMs: number;
  readonly max: number;
  readonly trustProxy: boolean;
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
    const key = clientAddress(c, options.trustProxy);
    let window = windows.get(key);
    if (!window || window.resetAt <= at) {
      window = { count: 0, resetAt: at + options.windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    const remaining = Math.max(0, options.max - window.count);
    const resetSeconds = Math.max(1, Math.ceil((window.resetAt - at) / 1000));
    c.header("ratelimit-limit", String(options.max));
    c.header("ratelimit-remaining", String(remaining));
    c.header("ratelimit-reset", String(resetSeconds));
    if (window.count > options.max) {
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
    await next();
  };
}

export function clientAddress(c: AppContext, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "local";
  }
}
