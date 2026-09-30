import { openPostgres } from "@nexora/db";

import { hashPassword } from "./auth/crypto.js";
import { ACTOR_ID } from "./auth/routes.js";
import { errorFields, jsonLogger } from "./observability.js";

/**
 * Creates a sign-in account when self sign-up is disabled (the production default).
 * Usage: NEXORA_NEW_USER_PASSWORD=... pnpm --filter @nexora/api user:create <actor-id>
 * The password is read from the environment so it stays out of shell history and process lists.
 */
const logger = jsonLogger();
const actorId = (process.argv[2] ?? "").trim().toLowerCase();
const password = process.env.NEXORA_NEW_USER_PASSWORD ?? "";
const url = process.env.DATABASE_URL;

if (!url) {
  logger.error("user.refused", { message: "DATABASE_URL is required." });
  process.exit(1);
}
if (!ACTOR_ID.test(actorId)) {
  logger.error("user.refused", {
    message: "Actor id must be 1–64 lowercase letters, digits, dot, dash, or underscore.",
  });
  process.exit(1);
}
if (password.length < 12 || password.length > 256) {
  logger.error("user.refused", { message: "NEXORA_NEW_USER_PASSWORD must be 12–256 characters." });
  process.exit(1);
}

const runtime = openPostgres(url, { max: 1 });
try {
  const outcome = await runtime.store.createUser({
    actorId,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  if (outcome === "exists") {
    logger.error("user.exists", { actorId });
    process.exitCode = 1;
  } else {
    logger.info("user.created", { actorId });
  }
} catch (error) {
  logger.error("user.failed", errorFields(error));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
