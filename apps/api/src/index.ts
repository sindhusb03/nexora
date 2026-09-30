import { serve } from "@hono/node-server";
import {
  createPgliteStore,
  openPostgres,
  type LedgerStore,
  type PostgresRuntimeReport,
} from "@nexora/db";

import { consoleEmailSender, MemoryMailbox } from "./auth/email.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type ApiConfig } from "./config.js";
import { seedDemo } from "./demo/seed.js";
import { createDirectory } from "./workspace/directory.js";
import { errorFields, jsonLogger, startTelemetry } from "./observability.js";
import { createErrorReporter } from "./reporting.js";

const logger = jsonLogger();

let config: ApiConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  logger.error("config.invalid", {
    message: error instanceof ConfigError ? error.message : "Configuration could not be read",
  });
  process.exit(1);
}
for (const warning of config.warnings) {
  logger.warn("config.warning", { message: warning });
}

const telemetry = await startTelemetry(
  { endpoint: config.otelEndpoint, traces: config.otelTraces, metrics: config.otelMetrics },
  logger,
);
const mailbox = new MemoryMailbox();
const email = consoleEmailSender(logger, mailbox);

let store: LedgerStore;
let closeStore: () => Promise<void> = async () => undefined;
if (config.databaseUrl) {
  const runtime = openPostgres(config.databaseUrl, {
    statementTimeoutMs: 30_000,
    onPoolError: (error) => logger.error("db.pool_error", errorFields(error)),
  });
  let report: PostgresRuntimeReport;
  try {
    report = await runtime.inspect();
  } catch (error) {
    logger.error("db.unreachable", errorFields(error));
    process.exit(1);
  }
  const { fatal, advisory } = assessRuntime(report, config.production);
  for (const message of advisory)
    logger.warn("db.role_advisory", { loginRole: report.loginRole, message });
  if (fatal.length > 0) {
    for (const message of fatal)
      logger.error("db.refused", { loginRole: report.loginRole, message });
    await runtime.close();
    process.exit(1);
  }
  store = runtime.store;
  closeStore = () => runtime.close();
} else {
  store = await createPgliteStore();
  logger.warn("store.ephemeral", {
    message: "DATABASE_URL is unset; using in-memory PGlite. Data is lost on restart.",
  });
}

const directory = createDirectory();
if (
  config.demoMode &&
  !config.production &&
  process.env.NEXORA_SEED_DEMO !== "false" &&
  !config.databaseUrl
) {
  await seedDemo(store, directory, config.platformAdminActorIds);
  logger.info("demo.seeded", {
    company: "Nazareno Services",
    actors: "sindhu,controller,viewer,platform-admin",
  });
}

const app = createApp({
  store,
  platformAdminActorIds: config.platformAdminActorIds,
  auth: config.auth,
  http: config.http,
  production: config.production,
  logger,
  storeKind: config.databaseUrl ? "postgres" : "pglite",
  directory,
  demoMode: config.demoMode,
  email,
  devMailbox: config.production ? null : mailbox,
  oidcProviders: config.oidcProviders,
  errorReporter: createErrorReporter(config.sentryDsn),
});

const server = serve({ fetch: app.fetch, port: config.port }, () => {
  logger.info("api.started", {
    port: config.port,
    store: config.databaseUrl ? "postgres" : "pglite",
    production: config.production,
    devHeaders: config.auth.devHeaders,
    signupAllowed: config.auth.allowSignup,
    tracesExported: telemetry.exporting,
  });
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("api.stopping", { signal });
  server.close();
  await Promise.allSettled([closeStore(), telemetry.shutdown()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function assessRuntime(
  report: PostgresRuntimeReport,
  production: boolean,
): { fatal: string[]; advisory: string[] } {
  const fatal: string[] = [];
  const privileged: string[] = [];
  if (!report.appRoleSafe)
    fatal.push(
      "Role nexora_app is missing, a superuser, or bypasses RLS. Run the migrations as the schema owner.",
    );
  if (!report.canUseAppRole)
    fatal.push(
      "The login role is not a member of nexora_app, so it cannot drop to the RLS-bound role.",
    );
  const { pending, drifted, unknown } = report.migrations;
  if (pending.length > 0)
    fatal.push(
      `Migrations are pending: ${pending.join(", ")}. Run pnpm --filter @nexora/api migrate first.`,
    );
  if (drifted.length > 0)
    fatal.push(`Applied migrations differ from this build: ${drifted.join(", ")}.`);
  if (unknown.length > 0)
    fatal.push(`The database has migrations this build does not know: ${unknown.join(", ")}.`);
  if (report.superuser) privileged.push("The login role is a superuser.");
  if (report.bypassRls) privileged.push("The login role has BYPASSRLS.");
  if (report.ownsKernelTables)
    privileged.push("The login role owns kernel tables and could disable row-level security.");
  if (production) {
    fatal.push(
      ...privileged.map(
        (message) => `${message} Production requires a dedicated login role (docs/operations.md).`,
      ),
    );
    return { fatal, advisory: [] };
  }
  return { fatal, advisory: privileged };
}
