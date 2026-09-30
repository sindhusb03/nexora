import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { OidcProviderConfig } from "./auth/oidc.js";

export interface ApiConfig {
  readonly production: boolean;
  readonly port: number;
  readonly databaseUrl: string | null;
  readonly platformAdminActorIds: readonly string[];
  readonly auth: AuthConfig;
  readonly http: HttpConfig;
  readonly otelEndpoint: string | null;
  readonly otelTraces: boolean;
  readonly otelMetrics: boolean;
  readonly sentryDsn: string | null;
  /** Keeps the seeded demo company and sindhu / nexora-demo-2026. Off in production. */
  readonly demoMode: boolean;
  readonly oidcProviders: readonly OidcProviderConfig[];
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
  /** How many rightmost X-Forwarded-For hops belong to our proxies. Used when trustProxy is set. */
  readonly trustedProxyHops: number;
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
  WEB_ORIGIN: z
    .string()
    .default("http://localhost:3000,http://127.0.0.1:4317,http://localhost:4317"),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(52_428_800).default(8_388_608),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_TRACES_EXPORTER: z.enum(["otlp", "none"]).optional(),
  OTEL_METRICS_EXPORTER: z.enum(["otlp", "none"]).optional(),
  SENTRY_DSN: z.string().optional(),
  DEMO_MODE: z.enum(["true", "false"]).optional(),
  OIDC_PROVIDERS: z.string().optional(),
});

const oidcProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().trim().min(1).max(80),
  issuer: z.string().url(),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(500).optional(),
  redirectUri: z.string().url(),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["openid", "email"]),
});

/** Reads the environment and fails closed on anything unsafe for production. */
export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim().length > 0),
  );
  const parsed = envSchema.safeParse(set);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `Invalid configuration ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "unknown"}`,
    );
  }
  const values = parsed.data;
  const production = values.NODE_ENV === "production";
  const warnings: string[] = [];

  if (production && !values.DATABASE_URL) {
    throw new ConfigError(
      "DATABASE_URL is required when NODE_ENV=production. The in-memory store is for development only.",
    );
  }
  const devHeaders = values.NEXORA_DEV_HEADERS === "true";
  if (production && devHeaders) {
    throw new ConfigError(
      "NEXORA_DEV_HEADERS=true is refused when NODE_ENV=production. Identity comes from signed sessions.",
    );
  }

  let secret = values.AUTH_SECRET?.trim() ?? "";
  if (secret.length === 0) {
    if (production) {
      throw new ConfigError(
        "AUTH_SECRET is required when NODE_ENV=production (at least 32 characters).",
      );
    }
    secret = randomBytes(32).toString("base64url");
    warnings.push(
      "AUTH_SECRET is unset; using an ephemeral secret, so sessions end when the API restarts.",
    );
  } else if (secret.length < 32) {
    throw new ConfigError("AUTH_SECRET must be at least 32 characters.");
  }

  const cookieSameSite = values.AUTH_COOKIE_SAMESITE;
  const cookieSecure = values.AUTH_COOKIE_SECURE
    ? values.AUTH_COOKIE_SECURE === "true"
    : production;
  if (cookieSameSite === "None" && !cookieSecure) {
    throw new ConfigError("AUTH_COOKIE_SAMESITE=None requires AUTH_COOKIE_SECURE=true.");
  }
  if (production && !cookieSecure) {
    throw new ConfigError("AUTH_COOKIE_SECURE=false is refused when NODE_ENV=production.");
  }

  const allowSignup = values.AUTH_ALLOW_SIGNUP ? values.AUTH_ALLOW_SIGNUP === "true" : !production;
  if (devHeaders) {
    warnings.push(
      "NEXORA_DEV_HEADERS=true: x-actor-id, x-tenant-id, and x-region are trusted. Never enable this outside local development.",
    );
  }

  const demoMode = values.DEMO_MODE === "true";
  if (production && demoMode) {
    throw new ConfigError(
      "DEMO_MODE=true is refused when NODE_ENV=production. The demo password is a local seed credential.",
    );
  }
  if (demoMode) {
    warnings.push(
      "DEMO_MODE is on. The seeded company and demo password are available. Turn this off outside local development.",
    );
  }

  const sentryDsn = values.SENTRY_DSN ?? null;
  if (sentryDsn && !/^https:\/\/[^@\s]+@[^/\s]+\/\d+$/.test(sentryDsn)) {
    throw new ConfigError("SENTRY_DSN must be an https Sentry DSN (https://key@host/project).");
  }

  let oidcProviders: OidcProviderConfig[] = [];
  if (values.OIDC_PROVIDERS) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(values.OIDC_PROVIDERS);
    } catch {
      throw new ConfigError("OIDC_PROVIDERS must be a JSON array.");
    }
    const parsedProviders = z.array(oidcProviderSchema).safeParse(parsedJson);
    if (!parsedProviders.success) {
      const issue = parsedProviders.error.issues[0];
      throw new ConfigError(
        `Invalid OIDC_PROVIDERS ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "unknown"}`,
      );
    }
    const ids = new Set<string>();
    oidcProviders = parsedProviders.data.map((provider) => {
      if (ids.has(provider.id)) {
        throw new ConfigError(`OIDC provider id ${provider.id} is duplicated.`);
      }
      ids.add(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        issuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret ?? null,
        redirectUri: provider.redirectUri,
        scopes: provider.scopes,
      };
    });
  }

  const tracesFlag = values.OTEL_TRACES_EXPORTER;
  const metricsFlag = values.OTEL_METRICS_EXPORTER;
  const otelEndpoint = values.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
  const otelTraces = tracesFlag ? tracesFlag === "otlp" : otelEndpoint !== null;
  const otelMetrics = metricsFlag ? metricsFlag === "otlp" : otelEndpoint !== null;
  if ((otelTraces || otelMetrics) && !otelEndpoint) {
    throw new ConfigError(
      "OTEL_TRACES_EXPORTER or OTEL_METRICS_EXPORTER=otlp requires OTEL_EXPORTER_OTLP_ENDPOINT.",
    );
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
      trustedProxyHops: values.TRUST_PROXY_HOPS,
      rateLimit: {
        windowMs: values.RATE_LIMIT_WINDOW_MS,
        max: values.RATE_LIMIT_MAX,
        authMax: values.AUTH_RATE_LIMIT_MAX,
      },
    },
    otelEndpoint,
    otelTraces,
    otelMetrics,
    sentryDsn,
    demoMode,
    oidcProviders,
    warnings,
  };
}
