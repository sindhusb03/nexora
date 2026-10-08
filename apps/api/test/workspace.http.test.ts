import { createPgliteStore } from "@nexora/db";
import { describe, expect, it } from "vitest";

import { seedDemo } from "../src/demo/seed.js";
import { createDirectory } from "../src/workspace/directory.js";
import { call, testApp, TEST_PASSWORD } from "./harness.js";

describe("workspace MVP", () => {
  it("serves kernel-backed statements, forecast, cash, QoE, and a grounded copilot", async () => {
    const store = await createPgliteStore();
    const directory = createDirectory();
    await seedDemo(store, directory, ["platform-admin"], 1_024, TEST_PASSWORD);
    const company = directory.list()[0];
    expect(company?.name).toBe("Nazareno Services");
    const app = await testApp({ store, directory, demoMode: true });
    const tenant = company?.tenantId ?? "";

    const workspace = await call(app, "GET", "/v1/workspace", { actor: "sindhu", tenant });
    const raw = await workspace.text();
    expect(workspace.status, raw).toBe(200);
    const body = JSON.parse(raw) as {
      latest: {
        assetsMinor: string;
        liabilitiesMinor: string;
        equityMinor: string;
        revenueMinor: string;
      };
      statements: {
        periods: unknown[];
        unavailablePeriods: unknown[];
        rows: { key: string; values: { minor: string }[] }[];
      };
      cash: {
        base: { weeks: unknown[]; alerts: unknown[] };
        downside: { alerts: { weekIndex: string }[] };
      };
      qoe: { reported: string; normalized: string; inputHash: string };
      approvals: { status: string }[];
      onboarding: { certificate: { status: string } };
      engineVersion: string;
    };
    expect(body.engineVersion).toBe("fe-kernel-0.3.0");
    expect(BigInt(body.latest.assetsMinor)).toBe(
      BigInt(body.latest.liabilitiesMinor) + BigInt(body.latest.equityMinor),
    );
    expect(body.latest.revenueMinor).toBe("15800000");
    expect(body.statements.periods.length).toBe(22);
    expect(body.statements.unavailablePeriods).toEqual([]);
    const row = (key: string) => body.statements.rows.find((item) => item.key === key);
    expect(row("cfo")?.values[0]?.minor).toBe("0");
    expect(row("cfi")?.values[0]?.minor).toBe("0");
    expect(row("cff")?.values[0]?.minor).toBe("0");
    expect(row("cfo")?.values[1]?.minor).toBe("1730000");
    expect(row("cfi")?.values[1]?.minor).toBe("-600000");
    expect(row("cff")?.values[1]?.minor).toBe("-250000");
    expect(body.statements.rows.map((row) => row.key)).toContain("end");
    expect(body.cash.base.weeks).toHaveLength(13);
    expect(body.cash.downside.alerts.length).toBeGreaterThan(0);
    expect(body.qoe.inputHash).toHaveLength(64);
    expect(BigInt(body.qoe.normalized)).toBeGreaterThan(BigInt(body.qoe.reported));
    expect(body.approvals.some((item) => item.status === "suggested")).toBe(true);
    expect(body.onboarding.certificate.status).toBe("unavailable");

    const viewer = await call(
      app,
      "POST",
      `/v1/workspace/proposals/${body.approvals[0] ? "00000000-0000-4000-8000-000000000000" : ""}/decide`,
      {
        actor: "viewer",
        tenant,
        body: { decision: "rejected" },
      },
    );
    expect(viewer.status).toBe(403);

    const aiEnvKeys = ["AI_API_KEY", "OPENAI_API_KEY", "AI_BASE_URL"] as const;
    const previousAiEnv = aiEnvKeys.map((key) => process.env[key]);
    for (const key of aiEnvKeys) delete process.env[key];
    try {
      const copilot = await call(app, "POST", "/v1/copilot", {
        actor: "sindhu",
        tenant,
        body: { message: "Explain revenue and cash.", agent: "general" },
      });
      expect(copilot.status).toBe(200);
      const answer = (await copilot.json()) as {
        mode: string;
        accepted: boolean;
        text: string;
        rejectedNumbers: string[];
      };
      expect(answer.mode).toBe("mock");
      expect(answer.accepted).toBe(true);
      expect(answer.rejectedNumbers).toEqual([]);
      expect(answer.text).toContain("15800000");
      expect(answer.text.toLowerCase()).not.toContain("agi");
    } finally {
      for (const [index, key] of aiEnvKeys.entries()) {
        const previous = previousAiEnv[index];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }

    const platform = await call(app, "GET", "/v1/admin/platform", { actor: "platform-admin" });
    expect(platform.status).toBe(200);
    const ops = (await platform.json()) as {
      tenants: { name: string }[];
      flags: unknown[];
      connectors: unknown[];
    };
    expect(ops.tenants[0]?.name).toBe("Nazareno Services");
    expect(ops.flags.length).toBeGreaterThan(0);
    expect(ops.connectors.length).toBeGreaterThan(0);

    const outsider = await call(app, "GET", "/v1/workspace", { actor: "owner-1", tenant });
    expect(outsider.status).toBe(403);
  });
});
