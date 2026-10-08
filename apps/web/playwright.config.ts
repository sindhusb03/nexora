import { defineConfig, devices } from "@playwright/test";

const reuse = !process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "pnpm --filter @nexora/api dev",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: reuse,
      env: {
        ...process.env,
        DEMO_MODE: "true",
        AUTH_ALLOW_SIGNUP: "true",
        AUTH_ALLOW_SIGNUP_WITH_PLATFORM_ADMINS: "true",
      },
      timeout: 180_000,
      cwd: "../..",
    },
    {
      command: "pnpm --filter @nexora/web dev",
      url: "http://127.0.0.1:4317",
      reuseExistingServer: reuse,
      timeout: 180_000,
      cwd: "../..",
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:8787",
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
