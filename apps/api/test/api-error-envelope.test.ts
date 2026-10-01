import { readApiError } from "@nexora/contracts";
import { describe, expect, it } from "vitest";

import { sessions, testApp } from "./harness.js";

describe("API error envelope", () => {
  it("parses CSRF and auth failures from the Hono app", async () => {
    const app = await testApp();
    const anonymous = await app.request("/v1/ingestion/uploads", { method: "POST" });
    expect(anonymous.status).toBe(401);
    expect(readApiError(await anonymous.json())?.code).toBe("AUTH_UNAUTHENTICATED");

    const session = await sessions(app).session("owner-1", "us-east-1", null);
    if (session instanceof Response) throw new Error("sign-in failed");
    const missing = await app.request("/v1/entities", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie },
      body: JSON.stringify({ legalName: "No Token", functionalCurrency: "USD" }),
    });
    expect(missing.status).toBe(403);
    const parsed = readApiError(await missing.json());
    expect(parsed?.code).toBe("AUTH_CSRF_FAILED");
    expect(parsed?.message).toContain("x-csrf-token");
  });
});
