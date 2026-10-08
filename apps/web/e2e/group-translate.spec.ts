import { expect, test } from "@playwright/test";

test("translates seeded books and shows the CTA and a zero sum", async ({ page }) => {
  await page.goto("/program?tab=group");
  await page.getByLabel("Actor ID").fill("sindhu");
  await page.getByLabel("Password").fill("nexora-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Open a company" })).toBeVisible();

  const companies = await page.evaluate(async () => {
    const response = await fetch("http://127.0.0.1:8787/v1/workspace/companies", {
      credentials: "include",
    });
    return { status: response.status, body: await response.text() };
  });
  expect(companies, JSON.stringify(companies)).toMatchObject({ status: 200 });
  const tenantId =
    (JSON.parse(companies.body) as { companies?: { tenantId: string }[] }).companies?.[0]
      ?.tenantId ?? "";
  expect(tenantId).not.toBe("");

  await page.getByLabel("Tenant ID").fill(tenantId);
  await page.getByRole("button", { name: "Open tenant" }).click();
  await expect(page.getByRole("heading", { name: "Group and FX" })).toBeVisible();
  await expect(page.getByTestId("translate-deferred")).toHaveCount(0);

  await page.getByLabel("Group name").fill("Nazareno EUR");
  await page.getByLabel("Reporting currency").fill("EUR");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByLabel("Consolidation group")).toContainText("Nazareno EUR");
  await expect(page.getByTestId("reporting-currency")).toContainText("EUR");

  await page.getByRole("checkbox", { name: /Nazareno Services LLC/ }).check();
  const period = page.getByLabel("Period for Nazareno Services LLC");
  await expect(period.locator("option")).not.toHaveCount(0);
  await expect
    .poll(async () => period.locator("option[value]:not([value=''])").count())
    .toBeGreaterThan(0);
  const periodId = await period
    .locator("option[value]:not([value=''])")
    .last()
    .getAttribute("value");
  expect(periodId).toBeTruthy();
  await period.selectOption(periodId ?? "");

  await page.getByLabel("Closing rate, USD to EUR").fill("0.90");
  await page.getByLabel("Historical rate, USD to EUR").fill("0.80");
  await page.getByLabel("Average rate, USD to EUR").fill("0.85");
  await page.getByTestId("translate-group").click();

  const cta = page.getByTestId("cta-line");
  await expect(cta).toBeVisible();
  await expect(cta).toContainText("Cumulative translation adjustment");
  await expect(cta).not.toContainText("€0.00");
  await expect(page.getByTestId("zero-sum")).toHaveText("Balances to zero");
  await expect(page.getByTestId("input-hash")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("output-hash")).toHaveText(/^[0-9a-f]{64}$/);
});
