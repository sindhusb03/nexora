import { createHttpIngestionClient } from "./http-client";
import { createMockIngestionClient, sessionStore } from "./mock-client";
import type { IngestionClient } from "./types";

export function isMockIngestion(): boolean {
  return (
    process.env.NEXT_PUBLIC_INGESTION_MODE === "mock" ||
    process.env.NEXT_PUBLIC_INGESTION_MODE === "demo"
  );
}

let client: IngestionClient | null = null;

/**
 * Use the real ingestion API by default. Explicit mock or demo mode uses fixtures.
 */
export function getIngestionClient(): IngestionClient {
  if (client) return client;
  client = isMockIngestion()
    ? createMockIngestionClient({ store: sessionStore() })
    : createHttpIngestionClient(process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787");
  return client;
}

export function resetIngestionClient(): void {
  client = null;
}
