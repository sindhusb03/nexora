import { ENGINE_VERSION, KernelError, isKernelError } from "@nexora/kernel";
import type { LedgerStore } from "@nexora/db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";

import { registerAuthRoutes } from "./auth/routes.js";
import { requireIdentity } from "./auth/session.js";
import type { AuthConfig, HttpConfig } from "./config.js";
import { ApiError, readActor, statusFor, type AppEnv } from "./http.js";
import { registerFileImportRoutes } from "./imports/file-import.js";
import { errorFields, jsonLogger, requestLog, type Logger } from "./observability.js";
import {
  accountSchema,
  dcfSchema,
  entitySchema,
  journalSchema,
  membershipSchema,
  periodSchema,
  provisionSchema,
  reversalSchema,
} from "./schemas.js";
import { registerProgramRoutes } from "./program-routes.js";
import { createProgramService } from "./program-service.js";
import { rateLimit } from "./security.js";
import { createLedgerService } from "./service.js";

const tracer = trace.getTracer("@nexora/api", "0.1.0");

export const DEFAULT_HTTP: HttpConfig = {
  webOrigins: ["http://localhost:3000"],
  bodyLimitBytes: 8_388_608,
  trustProxy: false,
  rateLimit: { windowMs: 60_000, max: 600, authMax: 20 },
};

export interface AppOptions {
  readonly store: LedgerStore;
  readonly platformAdminActorIds: readonly string[];
  readonly auth: AuthConfig;
  readonly http?: HttpConfig;
  readonly production?: boolean;
  readonly logger?: Logger;
  /** scrypt N for new password hashes. Tests lower it; production keeps the default. */
  readonly passwordCost?: number;
  readonly storeKind?: "postgres" | "pglite";
  /** Extra readiness gate beyond a store round trip, such as a migration check. */
  readonly readiness?: () => Promise<{ readonly ready: boolean; readonly reason?: string }>;
}

export function createApp(options: AppOptions) {
  const http = options.http ?? DEFAULT_HTTP;
  const logger = options.logger ?? jsonLogger();
  const service = createLedgerService(options.store, options.platformAdminActorIds);
  const program = createProgramService(options.store);
  const app = new Hono<AppEnv>();

  app.use("*", requestLog(logger));
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      xFrameOptions: "DENY",
      referrerPolicy: "no-referrer",
      crossOriginResourcePolicy: "same-site",
      strictTransportSecurity: options.production ? "max-age=63072000; includeSubDomains" : false,
    }),
  );

  const allowHeaders = [
    "content-type",
    "idempotency-key",
    "expected-version",
    "x-correlation-id",
    "x-request-id",
    "x-csrf-token",
    ...(options.auth.devHeaders ? ["x-actor-id", "x-tenant-id", "x-region"] : []),
  ];
  const corsMiddleware = cors({
    origin: [...http.webOrigins],
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders,
    exposeHeaders: ["x-correlation-id", "x-request-id", "retry-after"],
    maxAge: 600,
  });
  app.use("/v1/*", corsMiddleware);
  app.use("/auth/*", corsMiddleware);

  const credentialLimit = rateLimit({
    name: "sign-in",
    windowMs: http.rateLimit.windowMs,
    max: http.rateLimit.authMax,
    trustProxy: http.trustProxy,
  });
  const generalLimit = rateLimit({ name: "API", windowMs: http.rateLimit.windowMs, max: http.rateLimit.max, trustProxy: http.trustProxy });
  app.use("/auth/login", credentialLimit);
  app.use("/auth/signup", credentialLimit);
  app.use("/auth/*", generalLimit);
  app.use("/v1/*", generalLimit);

  const limitBody = bodyLimit({
    maxSize: http.bodyLimitBytes,
    onError: (c) =>
      c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${http.bodyLimitBytes} bytes` } }, 413),
  });
  app.use("/v1/*", limitBody);
  app.use("/auth/*", limitBody);
  app.use("/v1/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.use("/auth/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.use("/v1/*", requireIdentity({ store: options.store, auth: options.auth, webOrigins: http.webOrigins }));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ZodError) {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }
    if (isKernelError(error)) {
      return c.json({ error: { code: error.code, message: error.message } }, statusFor(error.code));
    }
    if (error instanceof SyntaxError) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "Request body must be valid JSON" } }, 400);
    }
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    logger.error("http.unhandled", { requestId: c.get("requestId"), ...errorFields(error) });
    return c.json({ error: { code: "INTERNAL", message: "Unexpected failure" } }, 500);
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "financial-kernel",
      engineVersion: ENGINE_VERSION,
    }),
  );

  app.get("/ready", async (c) => {
    try {
      await withTimeout(options.store.ping(), 2_000);
      const gate = options.readiness ? await options.readiness() : { ready: true };
      if (!gate.ready) {
        return c.json({ status: "not_ready", reason: gate.reason ?? "gate_failed" }, 503);
      }
      return c.json({ status: "ready", store: options.storeKind ?? "pglite", engineVersion: ENGINE_VERSION });
    } catch (error) {
      logger.warn("ready.failed", { requestId: c.get("requestId"), ...errorFields(error) });
      return c.json({ status: "not_ready", reason: "store_unreachable" }, 503);
    }
  });

  registerAuthRoutes(app, {
    store: options.store,
    auth: options.auth,
    webOrigins: http.webOrigins,
    platformAdminActorIds: options.platformAdminActorIds,
    logger,
    ...(options.passwordCost ? { passwordCost: options.passwordCost } : {}),
  });

  app.post("/v1/tenants", async (c) => {
    const body = provisionSchema.parse(await c.req.json());
    return c.json(await service.provisionTenant(readActor(c), body), 201);
  });

  app.post("/v1/memberships", async (c) => {
    const body = membershipSchema.parse(await c.req.json());
    return c.json(await service.grantMembership(readActor(c), body), 201);
  });

  app.post("/v1/entities", async (c) => {
    const body = entitySchema.parse(await c.req.json());
    return c.json(await service.createEntity(readActor(c), body), 201);
  });

  app.get("/v1/entities", async (c) => c.json(await service.listEntities(readActor(c))));

  app.get("/v1/entities/:entityId/accounts", async (c) =>
    c.json(await service.listAccounts(readActor(c), z.uuid().parse(c.req.param("entityId")))),
  );

  app.get("/v1/entities/:entityId/periods", async (c) =>
    c.json(await service.listPeriods(readActor(c), z.uuid().parse(c.req.param("entityId")))),
  );

  app.get("/v1/entities/:entityId/journals", async (c) => {
    const periodQuery = c.req.query("periodId");
    const periodId = periodQuery ? z.uuid().parse(periodQuery) : null;
    return c.json(await service.listJournals(readActor(c), z.uuid().parse(c.req.param("entityId")), periodId));
  });

  app.post("/v1/accounts", async (c) => {
    const body = accountSchema.parse(await c.req.json());
    return c.json(await service.createAccount(readActor(c), body), 201);
  });

  app.post("/v1/periods", async (c) => {
    const body = periodSchema.parse(await c.req.json());
    return c.json(await service.createPeriod(readActor(c), body), 201);
  });

  app.post("/v1/periods/:periodId/close", async (c) => {
    const periodId = c.req.param("periodId");
    return c.json(await service.closePeriod(readActor(c), periodId));
  });

  app.post("/v1/journals", async (c) => {
    const body = journalSchema.parse(await c.req.json());
    const actor = readActor(c);
    const journal = await traced("journal.post", () =>
      service.postJournal(actor, { ...body, sourceRef: body.sourceRef ?? null }),
    );
    c.header("x-correlation-id", actor.correlationId);
    return c.json(journal, journal.replayed ? 200 : 201);
  });

  app.get("/v1/journals/:journalId", async (c) => {
    return c.json(await service.getJournal(readActor(c), c.req.param("journalId")));
  });

  app.post("/v1/journals/:journalId/reverse", async (c) => {
    const body = reversalSchema.parse(await c.req.json());
    const actor = readActor(c);
    const journal = await traced("journal.reverse", () =>
      service.reverseJournal(actor, c.req.param("journalId"), {
        ...body,
        sourceRef: body.sourceRef ?? null,
      }),
    );
    c.header("x-correlation-id", actor.correlationId);
    return c.json(journal, 201);
  });

  app.get("/v1/entities/:entityId/periods/:periodId/statements", async (c) => {
    return c.json(
      await service.statements(readActor(c), c.req.param("entityId"), c.req.param("periodId")),
    );
  });

  app.post("/v1/valuations/dcf", async (c) => {
    const body = dcfSchema.parse(await c.req.json());
    const actor = readActor(c);
    const result = await traced("valuation.dcf", () => service.calculateDcf(actor, body));
    c.header("x-correlation-id", actor.correlationId);
    return c.json(result, 201);
  });

  app.get("/v1/audit", async (c) => c.json(await service.listAudit(readActor(c))));

  registerProgramRoutes(app, program);
  registerFileImportRoutes(app, options.store);

  return app;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof KernelError) {
        span.setAttribute("kernel.code", error.code);
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
