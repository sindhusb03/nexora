import { expect, test } from "@playwright/test";

test("group translate stays disabled until the group screen", async ({ page }) => {
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

  const translate = page.getByTestId("translate-group");
  await expect(translate).toBeVisible();
  await expect(translate).toBeDisabled();
  await expect(page.getByTestId("translate-deferred")).toContainText(
    "coming with the group screen",
  );
  await expect(page.getByRole("button", { name: "Create EUR group" })).toBeEnabled();
});
