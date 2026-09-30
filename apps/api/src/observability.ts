import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import type { MiddlewareHandler } from "hono";
import { metrics } from "@opentelemetry/api";
import pino from "pino";

import type { AppEnv } from "./http.js";

const httpRequests = metrics
  .getMeter("@nexora/api", "0.1.0")
  .createCounter("nexora.http.requests", {
    description: "HTTP requests observed by the API",
  });

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
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk).trimEnd());
      callback();
    },
  });
  const log = pino(
    {
      base: { service: "financial-kernel" },
      messageKey: "event",
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      redact: {
        paths: [
          "password",
          "passwordHash",
          "secret",
          "token",
          "cookie",
          "csrfToken",
          "authorization",
          "email",
          "clientSecret",
          "to",
          "*.password",
          "*.passwordHash",
          "*.secret",
          "*.token",
          "*.cookie",
          "*.csrfToken",
          "*.authorization",
          "*.email",
          "*.clientSecret",
        ],
        censor: "[redacted]",
      },
    },
    stream,
  );
  return {
    info: (event, fields) => {
      log.info(fields ?? {}, event);
    },
    warn: (event, fields) => {
      log.warn(fields ?? {}, event);
    },
    error: (event, fields) => {
      log.error(fields ?? {}, event);
    },
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
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    httpRequests.add(1, {
      method: c.req.method,
      path: c.req.path,
      status: String(c.res.status),
    });
    logger.info("http.request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
      actorId: identity?.actorId ?? null,
      userId: identity?.actorId ?? null,
      tenantId: identity?.tenantId ?? null,
      orgId: identity?.tenantId ?? null,
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
export interface TelemetryOptions {
  readonly endpoint: string | null;
  readonly traces: boolean;
  readonly metrics: boolean;
}

export async function startTelemetry(
  options: TelemetryOptions,
  logger: Logger,
): Promise<Telemetry> {
  const disabled: Telemetry = { exporting: false, shutdown: async () => undefined };
  if (!options.endpoint || (!options.traces && !options.metrics)) {
    logger.info("telemetry.disabled", {
      reason: "OTLP export is off; spans and metrics stay in-process no-ops",
    });
    return disabled;
  }
  const endpoint = options.endpoint.replace(/\/$/, "");
  try {
    const sdkExports: unknown = await import("@opentelemetry/sdk-node");
    const traceExports: unknown = await import("@opentelemetry/exporter-trace-otlp-http");
    const metricExports: unknown = await import("@opentelemetry/exporter-metrics-otlp-http");
    const readerExports: unknown = await import("@opentelemetry/sdk-metrics");
    const NodeSDK = constructorFrom(sdkExports, "NodeSDK");
    const OTLPTraceExporter = constructorFrom(traceExports, "OTLPTraceExporter");
    const OTLPMetricExporter = constructorFrom(metricExports, "OTLPMetricExporter");
    const PeriodicExportingMetricReader = constructorFrom(
      readerExports,
      "PeriodicExportingMetricReader",
    );
    if (!NodeSDK || !OTLPTraceExporter || !OTLPMetricExporter || !PeriodicExportingMetricReader) {
      throw new Error("OpenTelemetry modules did not expose the expected constructors");
    }
    const sdk = new NodeSDK({
      serviceName: "financial-kernel",
      ...(options.traces
        ? { traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) }
        : {}),
      ...(options.metrics
        ? {
            metricReaders: [
              new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
                exportIntervalMillis: 60_000,
              }),
            ],
          }
        : {}),
    }) as NodeSdkLike;
    sdk.start();
    logger.info("telemetry.started", {
      endpoint,
      traces: options.traces,
      metrics: options.metrics,
    });
    return { exporting: true, shutdown: () => sdk.shutdown() };
  } catch {
    logger.warn("telemetry.unavailable", {
      endpoint,
      reason: "OpenTelemetry SDK failed to start; spans and metrics remain no-ops",
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
