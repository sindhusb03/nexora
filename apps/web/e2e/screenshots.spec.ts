import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const enabled = process.env.NEXORA_SCREENSHOTS === "1";
const outDir = process.env.NEXORA_SCREENSHOT_DIR ?? "/opt/cursor/artifacts/screenshots";

async function signIn(page: Page) {
  await page.goto("/studio");
  await page.getByTestId("signin-actor").fill("sindhu");
  await page.getByTestId("signin-password").fill("nexora-demo-2026");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("screen-dashboard")).toBeVisible();
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

test.describe("studio screenshots", () => {
  test.skip(!enabled, "set NEXORA_SCREENSHOTS=1 to capture artifacts");

  test("light and dark product surfaces", async ({ page }) => {
    await mkdir(outDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    for (const theme of ["light", "dark"] as const) {
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      if (theme === "dark" && !isDark) await page.getByTestId("theme-toggle").click();
      if (theme === "light" && isDark) await page.getByTestId("theme-toggle").click();

      await page.getByTestId("nav-dashboard").click();
      await expect(page.getByTestId("screen-dashboard")).toBeVisible();
      await expect(page.locator(".nx-chart canvas")).toBeVisible();
      await shot(page, `dashboard-${theme}`);

      await page.getByTestId("nav-statements").click();
      await expect(page.getByTestId("statement-grid")).toBeVisible();
      await shot(page, `statements-${theme}`);

      await page.getByTestId("nav-forecast").click();
      await expect(page.getByTestId("screen-forecast")).toBeVisible();
      await page.getByTestId("scenario-switch").selectOption("downside");
      await shot(page, `forecast-${theme}`);
      await page.getByTestId("scenario-switch").selectOption("base");

      await page.getByTestId("nav-cash").click();
      await expect(page.getByTestId("screen-cash")).toBeVisible();
      await shot(page, `cash-${theme}`);

      await page.getByTestId("nav-qoe").click();
      await expect(page.getByTestId("screen-qoe")).toBeVisible();
      await shot(page, `qoe-${theme}`);

      await page.getByTestId("nav-approvals").click();
      await page.getByTestId("open-copilot").click();
      await expect(page.getByTestId("copilot-drawer")).toBeVisible();
      await expect(page.getByTestId("copilot-mode")).toContainText("Mock");
      if (theme === "light") {
        await page.getByTestId("copilot-send").click();
        await expect(page.getByTestId("copilot-thread")).toContainText("15800000");
      }
      await expect(page.getByTestId("screen-approvals")).toBeVisible();
      await shot(page, `copilot-approvals-${theme}`);
      await page.keyboard.press("Escape");
    }
  });
});
