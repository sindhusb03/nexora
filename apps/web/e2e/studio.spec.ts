import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, actorId: string) {
  await page.goto("/studio");
  await page.getByTestId("signin-actor").fill(actorId);
  await page.getByTestId("signin-password").fill("nexora-demo-2026");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("screen-dashboard")).toBeVisible();
}

test("owner walks the company workspace and asks the mock copilot", async ({ page }) => {
  await signIn(page, "sindhu");
  await expect(page.getByText("$158,000.00").first()).toBeVisible();
  await page.getByTestId("nav-statements").click();
  await expect(page.getByTestId("statement-grid")).toBeVisible();
  await page.getByTestId("statement-filter").fill("cash");
  await expect(page.getByText("Ending cash").first()).toBeVisible();
  await page.getByTestId("open-palette").click();
  await page.getByTestId("command-input").fill("cash");
  await page.getByText("13-week cash").click();
  await expect(page.getByTestId("screen-cash")).toBeVisible();
  await page.getByTestId("scenario-switch").selectOption("downside");
  await expect(page.getByText("Downside case")).toBeVisible();
  await page.getByTestId("nav-qoe").click();
  await expect(page.getByTestId("screen-qoe")).toBeVisible();
  await page.getByTestId("open-copilot").click();
  await page.getByTestId("copilot-send").click();
  await expect(page.getByTestId("copilot-thread")).toContainText("mock");
  await expect(page.getByTestId("copilot-thread")).toContainText("15800000");
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByTestId("accept-proposal").first()).toBeEnabled();
});

test("a viewer cannot accept a proposal", async ({ page }) => {
  await signIn(page, "viewer");
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByTestId("accept-proposal").first()).toBeDisabled();
});

test("platform admin sees connectors and flags", async ({ page }) => {
  await signIn(page, "platform-admin");
  await page.getByTestId("nav-platform").click();
  await expect(page.getByTestId("screen-platform")).toContainText("Tally");
  await expect(page.getByTestId("flag-excel_addin")).toContainText("Off");
});
