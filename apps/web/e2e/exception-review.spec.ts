import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, actorId = "sindhu") {
  await page.goto("/studio");
  await page.getByTestId("signin-actor").fill(actorId);
  await page.getByTestId("signin-password").fill("nexora-demo-2026");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("screen-dashboard")).toBeVisible();
}

async function shot(page: Page, name: string) {
  const directory = process.env.NEXORA_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}

test("triage extraction exceptions without posting", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("nav-review").click();
  await expect(page.getByTestId("screen-upload")).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles({
    name: "nazareno-income.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("account,amount\nRevenue,158000.00\n"),
  });
  await page.getByTestId("start-extraction").click();
  await expect(page.getByTestId("job-status")).toContainText("ready", { timeout: 20_000 });
  await shot(page, "01-upload-ready");
  await page.getByTestId("open-exceptions").click();
  await expect(page.getByTestId("exception-queue")).toBeVisible();
  await expect(page.getByTestId("review-as-of")).toHaveText("As of 2025-12-31");
  await expect(page.getByTestId("count-error")).toContainText("2");
  await expect(page.getByTestId("model-ready")).toContainText("Model not ready");

  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-help")).toBeVisible();
  await shot(page, "02-shortcuts");
  await page.keyboard.press("Escape");

  const queue = page.getByTestId("exception-queue");
  await queue.focus();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.getByTestId("exception-bank_to_book")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("k");
  await expect(page.getByTestId("exception-unmapped_account")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("j");
  await page.keyboard.press("a");
  await expect(page.getByTestId("confirm-key")).toContainText("Press a again");
  await page.keyboard.press("a");
  await expect(page.getByTestId("exception-bank_to_book")).toContainText("Accepted");

  await page.keyboard.press("/");
  await expect(page.getByTestId("exception-search")).toBeFocused();
  await page.getByTestId("exception-search").fill("GST");
  await expect(page.getByTestId("exception-tax_tie")).toBeVisible();
  await page.getByTestId("exception-search").fill("");

  await page.getByRole("link", { name: /Assets do not equal/ }).click();
  await expect(page.getByTestId("screen-detail")).toBeVisible();
  const source = page.getByTestId("source-pdf");
  await expect(source).toHaveAttribute("data-render", "pdf", { timeout: 20_000 });
  await expect(source).toHaveAttribute("data-page", "2");
  await expect(page.getByTestId("pdf-text")).toContainText("Total assets");
  await expect(page.getByTestId("bbox-highlight")).toBeVisible();
  const ink = await source.locator("canvas").evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) return 0;
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      const red = pixels[index] ?? 255;
      const green = pixels[index + 1] ?? 255;
      const blue = pixels[index + 2] ?? 255;
      const alpha = pixels[index + 3] ?? 0;
      if (alpha > 0 && (red < 250 || green < 250 || blue < 250)) count += 1;
    }
    return count;
  });
  expect(ink).toBeGreaterThan(20);
  await shot(page, "03-pdf-detail");
  await page.getByTestId("action-correct").click();
  await page.getByTestId("correct-value").fill("12420000000");
  await page.getByTestId("resolution-note").fill("Tie assets to liabilities and equity");
  await page.getByTestId("confirm-resolution").click();
  await expect(page.getByTestId("audit-trail")).toContainText("sindhu");
  await expect(page.getByTestId("audit-trail")).toContainText("12420000000");

  await page.getByTestId("back-to-queue").click();
  await page.getByRole("link", { name: /not mapped/ }).click();
  await expect(page.getByTestId("sheet-highlight")).toContainText("Implementation fees");
  await shot(page, "04-sheet-detail");
  await page.getByTestId("action-remap").click();
  await page.getByTestId("account-picker").selectOption("4000");
  await page.getByTestId("resolution-note").fill("Map implementation fees to service revenue");
  await page.getByTestId("confirm-resolution").click();
  await expect(page.getByTestId("audit-trail")).toContainText("4000");

  await page.getByTestId("back-to-queue").click();
  await expect(page.getByTestId("blocking-remaining")).toHaveText("0 blocking errors remaining");
  await expect(page.getByTestId("model-ready")).toHaveText("Model ready");
  await page.getByTestId("bulk-accept").click();
  await expect(page.getByTestId("bulk-confirm")).toBeVisible();
  await expect(page.getByTestId("bulk-list")).toContainText("header_as_value");
  await expect(page.getByTestId("bulk-list")).toContainText("expected");
  await expect(page.getByTestId("bulk-list")).not.toContainText("sign_convention");
  await expect(page.getByTestId("bulk-list")).not.toContainText("duplicate_extraction");
  await expect(page.getByTestId("bulk-list")).not.toContainText("unit_scale");
  await expect(page.getByTestId("bulk-list")).not.toContainText("low_confidence_extraction");
  await shot(page, "05-bulk-confirm");
  await page.getByTestId("bulk-confirm-submit").click();
  await expect(
    page.getByTestId("exception-header_as_value").filter({ hasText: 'The column header "Amount"' }),
  ).toContainText("Accepted");
  await expect(page.getByTestId("exception-sign_convention")).toContainText("Open");
  await expect(page.getByTestId("exception-duplicate_extraction")).toContainText("Open");
  await expect(page.getByTestId("exception-unit_scale")).toContainText("Open");
  await expect(page.getByTestId("exception-low_confidence_extraction")).toContainText("Open");
  await expect(page.getByText("Nothing was posted")).toBeVisible();
  await shot(page, "06-queue-ready");
});

test("a viewer cannot resolve or bulk-accept", async ({ page }) => {
  await signIn(page, "viewer");
  await page.getByTestId("nav-review").click();
  await page.getByTestId("upload-input").setInputFiles({
    name: "nazareno-income.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("account,amount\nRevenue,158000.00\n"),
  });
  await page.getByTestId("start-extraction").click();
  await expect(page.getByTestId("job-status")).toContainText("ready", { timeout: 20_000 });
  await page.getByTestId("open-exceptions").click();
  await expect(page.getByTestId("bulk-accept")).toBeDisabled();
  await page.getByTestId("exception-queue").focus();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  await expect(page.getByTestId("exception-bank_to_book")).toContainText("Open");
  await expect(page.getByTestId("queue-notice")).toContainText("cannot record a resolution");
});

test("numbered headers cannot be accepted by button or shortcut and stay out of bulk confirmation", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("nav-review").click();
  await page.getByTestId("upload-input").setInputFiles({
    name: "headers.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("account,amount\nPeriod,FY2025\n"),
  });
  await page.getByTestId("start-extraction").click();
  await expect(page.getByTestId("job-status")).toContainText("ready");
  await page.getByTestId("open-exceptions").click();
  const numberedMessage = 'The period header "FY2025" carries an extracted number.';
  const emptyMessage = 'The column header "Amount" was read as a numeric row.';
  const explanation =
    "This header contains a number and cannot be accepted. Choose not applicable or correct.";
  const numberedRow = page.getByRole("row").filter({ hasText: numberedMessage });
  await numberedRow.getByText("Open", { exact: true }).click();
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  await expect(page.getByTestId("queue-notice")).toHaveText(explanation);
  await expect(page.getByTestId("confirm-key")).toHaveCount(0);
  await expect(numberedRow).toContainText("Open");

  await page.getByRole("link", { name: numberedMessage, exact: true }).click();
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toBeDisabled();
  await expect(accept).toHaveAccessibleDescription(explanation);
  await expect(page.getByTestId("action-correct")).toBeEnabled();
  await expect(page.getByTestId("action-not-applicable")).toBeEnabled();
  await page.getByRole("heading", { name: numberedMessage, exact: true }).focus();
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  await expect(page.getByTestId("confirm-resolution")).toHaveCount(0);
  await expect(page.getByTestId("screen-detail").getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByText("No resolutions yet.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("audit-trail").getByRole("listitem")).toHaveCount(0);

  await page.getByTestId("back-to-queue").click();
  await page.getByTestId("bulk-accept").click();
  const list = page.getByTestId("bulk-list");
  await expect(list).toContainText(emptyMessage);
  await expect(list).not.toContainText(numberedMessage);
  await expect(list).not.toContainText("low_confidence_extraction");
  await expect(list).not.toContainText("missing_period");
  await page.getByTestId("bulk-confirm-submit").click();
  await expect(numberedRow).toContainText("Open");
  await expect(page.getByTestId("exception-low_confidence_extraction")).toContainText("Open");
  await expect(page.getByRole("row").filter({ hasText: emptyMessage })).toContainText("Accepted");
});
