import { randomBytes } from "node:crypto";

import { z } from "zod";

export interface ApiConfig {
  readonly production: boolean;
  readonly port: number;
  readonly databaseUrl: string | null;
  readonly platformAdminActorIds: readonly string[];
  readonly auth: AuthConfig;
  readonly http: HttpConfig;
  readonly otelEndpoint: string | null;
  /** Human-readable notes about development-only defaults that are in effect. */
  readonly warnings: readonly string[];
}

export interface AuthConfig {
  readonly secret: string;
  readonly sessionTtlSeconds: number;
  readonly allowSignup: boolean;
  /** Trust x-actor-id / x-tenant-id / x-region. Local development and tests only. */
  readonly devHeaders: boolean;
  readonly cookieSecure: boolean;
  readonly cookieSameSite: "Strict" | "Lax" | "None";
  /** When set, every session is issued for this region. */
  readonly pinnedRegion: string | null;
}

export interface HttpConfig {
  readonly webOrigins: readonly string[];
  readonly bodyLimitBytes: number;
  readonly trustProxy: boolean;
  readonly rateLimit: { readonly windowMs: number; readonly max: number; readonly authMax: number };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().trim().min(1).optional(),
  PLATFORM_ADMIN_ACTOR_IDS: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(28_800),
  AUTH_ALLOW_SIGNUP: z.enum(["true", "false"]).optional(),
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  AUTH_COOKIE_SAMESITE: z.enum(["Strict", "Lax", "None"]).default("Lax"),
  NEXORA_DEV_HEADERS: z.enum(["true", "false"]).optional(),
  NEXORA_REGION: z.string().regex(REGION).optional(),
  WEB_ORIGIN: z.string().default("http://localhost:3000,http://127.0.0.1:4317,http://localhost:4317"),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(52_428_800).default(8_388_608),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

/** Reads the environment and fails closed on anything unsafe for production. */
export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim().length > 0));
  const parsed = envSchema.safeParse(set);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`Invalid configuration ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "unknown"}`);
  }
  const values = parsed.data;
  const production = values.NODE_ENV === "production";
  const warnings: string[] = [];

  if (production && !values.DATABASE_URL) {
    throw new ConfigError("DATABASE_URL is required when NODE_ENV=production. The in-memory store is for development only.");
  }
  const devHeaders = values.NEXORA_DEV_HEADERS === "true";
  if (production && devHeaders) {
    throw new ConfigError("NEXORA_DEV_HEADERS=true is refused when NODE_ENV=production. Identity comes from signed sessions.");
  }

  let secret = values.AUTH_SECRET?.trim() ?? "";
  if (secret.length === 0) {
    if (production) {
      throw new ConfigError("AUTH_SECRET is required when NODE_ENV=production (at least 32 characters).");
    }
    secret = randomBytes(32).toString("base64url");
    warnings.push("AUTH_SECRET is unset; using an ephemeral secret, so sessions end when the API restarts.");
  } else if (secret.length < 32) {
    throw new ConfigError("AUTH_SECRET must be at least 32 characters.");
  }

  const cookieSameSite = values.AUTH_COOKIE_SAMESITE;
  const cookieSecure = values.AUTH_COOKIE_SECURE ? values.AUTH_COOKIE_SECURE === "true" : production;
  if (cookieSameSite === "None" && !cookieSecure) {
    throw new ConfigError("AUTH_COOKIE_SAMESITE=None requires AUTH_COOKIE_SECURE=true.");
  }
  if (production && !cookieSecure) {
    throw new ConfigError("AUTH_COOKIE_SECURE=false is refused when NODE_ENV=production.");
  }

  const allowSignup = values.AUTH_ALLOW_SIGNUP ? values.AUTH_ALLOW_SIGNUP === "true" : !production;
  if (devHeaders) {
    warnings.push("NEXORA_DEV_HEADERS=true: x-actor-id, x-tenant-id, and x-region are trusted. Never enable this outside local development.");
  }

  const webOrigins = values.WEB_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of webOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new ConfigError(`WEB_ORIGIN entry ${origin} must be a scheme and host with no path.`);
    }
  }

  return {
    production,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL ?? null,
    platformAdminActorIds: (values.PLATFORM_ADMIN_ACTOR_IDS ?? (production ? "" : "platform-admin"))
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    auth: {
      secret,
      sessionTtlSeconds: values.AUTH_SESSION_TTL_SECONDS,
      allowSignup,
      devHeaders,
      cookieSecure,
      cookieSameSite,
      pinnedRegion: values.NEXORA_REGION ?? null,
    },
    http: {
      webOrigins,
      bodyLimitBytes: values.API_BODY_LIMIT_BYTES,
      trustProxy: values.TRUST_PROXY === "true",
      rateLimit: {
        windowMs: values.RATE_LIMIT_WINDOW_MS,
        max: values.RATE_LIMIT_MAX,
        authMax: values.AUTH_RATE_LIMIT_MAX,
      },
    },
    otelEndpoint: values.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
    warnings,
  };
}
