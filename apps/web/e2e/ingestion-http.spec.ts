import { expect, test } from "@playwright/test";

test("reviews an upload through the real demo ingestion API", async ({ page }) => {
  await page.goto("/review");
  await page.getByLabel("Actor", { exact: true }).fill("sindhu");
  await page.getByLabel("Password", { exact: true }).fill("nexora-demo-2026");
  await page.getByRole("button", { name: "Open the company" }).click();
  await expect(page.getByTestId("screen-upload")).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles({
    name: "http-review.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "Balance sheet,INR",
        "Year ended 31 December 2025",
        "Account,2025",
        "Cash,1000",
        "Accounts Payable,200",
        "Retained Earnings,300",
        "Sundry consulting fee,50",
      ].join("\n"),
    ),
  });
  await expect(page.getByTestId("start-extraction")).toBeEnabled();
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/ingestion/uploads") && response.request().method() === "POST",
  );
  await page.getByTestId("start-extraction").click();
  const response = await uploaded;
  expect(response.status()).toBe(201);
  expect(response.request().headers()["content-type"]).toContain("multipart/form-data");
  await expect(page.getByTestId("job-status")).toContainText(/needs review|posted/);
  await page.getByTestId("open-exceptions").click();
  await expect(page.getByTestId("exception-queue")).toBeVisible();
  await page.getByTestId("exception-queue").getByRole("link").first().click();
  await expect(page.getByTestId("screen-detail")).toBeVisible();
  await page.getByTestId("action-not-applicable").click();
  await page.getByTestId("resolution-note").fill("Reviewed source in HTTP integration test");
  const resolved = page.waitForResponse(
    (response) =>
      /\/ingestion\/exceptions\/[^/]+\/resolve$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  await page.getByTestId("confirm-resolution").click();
  expect((await resolved).status()).toBe(200);
  await expect(page.getByTestId("audit-trail")).toContainText(
    "Reviewed source in HTTP integration test",
  );
  await page.reload();
  await expect(page.getByTestId("audit-trail")).toContainText(
    "Reviewed source in HTTP integration test",
  );
});
