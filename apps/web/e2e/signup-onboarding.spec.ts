import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const artifacts = process.env.NEXORA_E2E_ARTIFACTS;
const PASSWORD = "correct horse battery staple";

async function shot(page: Page, name: string): Promise<void> {
  if (!artifacts) return;
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/${name}`, fullPage: true });
}

test("sign up, set up a company, and land on it", async ({ page }) => {
  const actorId = `own${Date.now().toString(36)}`;
  await page.goto("/studio");
  await page.getByTestId("signin-signup").click();
  await expect(page).toHaveURL(/\/studio\/sign-up$/);
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await shot(page, "signup.png");

  await page.getByTestId("signup-actor").fill(actorId);
  await page.getByTestId("signup-email").fill(`${actorId}@example.com`);
  await page.getByTestId("signup-password").fill(PASSWORD);
  await page.getByTestId("signup-confirm").fill(PASSWORD);
  await page.getByTestId("signup-submit").click();

  await expect(page.getByTestId("first-run")).toBeVisible();
  await shot(page, "onboarding-company.png");
  await page.getByTestId("company-name").fill("Harbor Analytics");
  await page.getByTestId("first-run-next").click();

  await expect(page.getByTestId("base-currency")).toBeVisible();
  await shot(page, "onboarding-currency.png");
  await page.getByTestId("base-currency").fill("INR");
  await page.getByTestId("first-run-next").click();

  await expect(page.getByTestId("fye-month")).toHaveValue("3");
  await expect(page.getByTestId("fye-day")).toHaveValue("31");
  await shot(page, "onboarding-year-end.png");
  // The control leaves the page as soon as the company opens, so click in the page
  // instead of waiting for Playwright to confirm the node stayed mounted.
  await page
    .getByRole("button", { name: "Open company" })
    .evaluate((element: HTMLButtonElement) => {
      element.click();
    });

  const home = page.getByTestId("company-home");
  await expect(home).toBeVisible();
  await expect(page.getByRole("heading", { name: "Harbor Analytics" })).toBeVisible();
  await expect(home).toContainText("INR");
  await expect(home).toContainText("31 March");
  await shot(page, "company-home.png");
});
