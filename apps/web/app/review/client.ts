import { createHttpIngestionClient } from "./http-client";
import { createMockIngestionClient, sessionStore } from "./mock-client";
import type { IngestionClient } from "./types";

let client: IngestionClient | null = null;

/**
 * Switch the review UI from the fixture mock to the real ingestion API by setting
 * NEXT_PUBLIC_INGESTION_MODE=http. No other call site should branch on the mode.
 */
export function getIngestionClient(): IngestionClient {
  if (client) return client;
  client =
    process.env.NEXT_PUBLIC_INGESTION_MODE === "http"
      ? createHttpIngestionClient(process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787")
      : createMockIngestionClient({ store: sessionStore() });
  return client;
}

export function resetIngestionClient(): void {
  client = null;
}
