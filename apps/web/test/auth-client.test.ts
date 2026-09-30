import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeMagicLink, login } from "../app/studio/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-in region", () => {
  it("sends the deployment region from config and does not invent one", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ mfaRequired: true, challengeId: "challenge" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await login("sindhu", "secret", "ap-south-1");
    await consumeMagicLink("token-token-token-token", null);
    expect(bodies[0]).toEqual({ actorId: "sindhu", password: "secret", region: "ap-south-1" });
    expect(bodies[1]).toEqual({ token: "token-token-token-token" });
    expect(JSON.stringify(bodies)).not.toContain("us-east-1");
  });
});
