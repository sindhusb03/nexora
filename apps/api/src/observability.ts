import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "./http.js";

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Structured logs. Callers pass identifiers and codes only; bodies, passwords, cookies, and amounts are never fields. */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function jsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: string, event: string, fields?: LogFields) =>
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        service: "financial-kernel",
        ...fields,
      }),
    );
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const INBOUND_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Assigns a request id, echoes it, and writes one access log line per request. */
export function requestLog(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inbound = c.req.header("x-request-id")?.trim() ?? "";
    const requestId = INBOUND_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    c.set("requestId", requestId);
    c.set("identity", null);
    c.header("x-request-id", requestId);
    const started = performance.now();
    await next();
    const identity = c.get("identity");
    logger.info("http.request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      actorId: identity?.actorId ?? null,
      tenantId: identity?.tenantId ?? null,
      identitySource: identity?.source ?? null,
    });
  };
}

/** Error fields safe to log: the class name and a Postgres SQLSTATE if one is present. Messages can carry query parameters. */
export function errorFields(error: unknown): LogFields {
  const name = error instanceof Error ? error.name : typeof error;
  let code: string | null = null;
  const queue: unknown[] = [error];
  while (queue.length > 0 && code === null) {
    const current = queue.shift();
    if (typeof current === "object" && current !== null) {
      if (
        "code" in current &&
        typeof current.code === "string" &&
        /^[0-9A-Z]{5}$/.test(current.code)
      ) {
        code = current.code;
      }
      if ("cause" in current) queue.push(current.cause);
    }
  }
  return { errorName: name, sqlState: code };
}

export interface Telemetry {
  readonly exporting: boolean;
  shutdown(): Promise<void>;
}

interface NodeSdkLike {
  start(): void;
  shutdown(): Promise<void>;
}

/**
 * Spans in the API use @opentelemetry/api, which is a no-op until an SDK registers.
 * With OTEL_EXPORTER_OTLP_ENDPOINT set, this loads @opentelemetry/sdk-node and the OTLP HTTP exporter
 * if they are installed. Without them, it logs that traces are not exported and keeps the no-op tracer.
 */
export async function startTelemetry(endpoint: string | null, logger: Logger): Promise<Telemetry> {
  const disabled: Telemetry = { exporting: false, shutdown: async () => undefined };
  if (!endpoint) {
    logger.info("telemetry.disabled", {
      reason: "OTEL_EXPORTER_OTLP_ENDPOINT is unset; spans stay in-process no-ops",
    });
    return disabled;
  }
  const sdkModule = "@opentelemetry/sdk-node";
  const exporterModule = "@opentelemetry/exporter-trace-otlp-http";
  try {
    const sdkExports: unknown = await import(sdkModule);
    const exporterExports: unknown = await import(exporterModule);
    const NodeSDK = constructorFrom(sdkExports, "NodeSDK");
    const OTLPTraceExporter = constructorFrom(exporterExports, "OTLPTraceExporter");
    if (!NodeSDK || !OTLPTraceExporter) {
      throw new Error("OpenTelemetry modules did not expose NodeSDK and OTLPTraceExporter");
    }
    const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` });
    const sdk = new NodeSDK({
      serviceName: "financial-kernel",
      traceExporter: exporter,
    }) as NodeSdkLike;
    sdk.start();
    logger.info("telemetry.started", { endpoint });
    return { exporting: true, shutdown: () => sdk.shutdown() };
  } catch {
    logger.warn("telemetry.unavailable", {
      endpoint,
      reason: `Install ${sdkModule} and ${exporterModule} in @nexora/api to export traces; spans remain no-ops`,
    });
    return disabled;
  }
}

type Constructor = new (options: Record<string, unknown>) => unknown;

function constructorFrom(moduleExports: unknown, key: string): Constructor | null {
  if (typeof moduleExports !== "object" || moduleExports === null) return null;
  const value: unknown = (moduleExports as Record<string, unknown>)[key];
  return typeof value === "function" ? (value as Constructor) : null;
}
