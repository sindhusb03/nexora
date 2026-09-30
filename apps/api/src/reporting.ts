import { randomUUID } from "node:crypto";

/** Sentry-compatible reporter. No-ops when SENTRY_DSN is unset. Unexpected errors only. */
export interface ErrorReporter {
  captureException(
    error: unknown,
    context: { readonly requestId: string; readonly actorId: string | null },
  ): void;
}

export const noopReporter: ErrorReporter = {
  captureException() {
    return undefined;
  },
};

export function createErrorReporter(dsn: string | null): ErrorReporter {
  if (!dsn) return noopReporter;
  const parsed = parseDsn(dsn);
  if (!parsed) return noopReporter;
  return {
    captureException(error, context) {
      const eventId = randomUUID().replace(/-/g, "");
      const name = error instanceof Error ? error.name : "Error";
      const envelope = [
        JSON.stringify({ event_id: eventId, dsn, sent_at: new Date().toISOString() }),
        JSON.stringify({ type: "event" }),
        JSON.stringify({
          event_id: eventId,
          timestamp: Date.now() / 1000,
          platform: "node",
          level: "error",
          logger: "financial-kernel",
          tags: { request_id: context.requestId },
          user: context.actorId ? { id: context.actorId } : undefined,
          exception: {
            values: [{ type: name, value: "Unexpected failure" }],
          },
        }),
      ].join("\n");
      void fetch(`${parsed.endpoint}?sentry_key=${encodeURIComponent(parsed.key)}`, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope,
      }).catch(() => undefined);
    },
  };
}

function parseDsn(dsn: string): { endpoint: string; key: string } | null {
  try {
    const url = new URL(dsn);
    const key = decodeURIComponent(url.username);
    const project = url.pathname.replace(/^\//, "");
    if (!key || !/^\d+$/.test(project)) return null;
    return { key, endpoint: `${url.origin}/api/${project}/envelope/` };
  } catch {
    return null;
  }
}
