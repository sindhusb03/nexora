import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

mkdirSync("/opt/cursor/artifacts", { recursive: true });

const API = "http://127.0.0.1:8787";
const PASSWORD = "correct horse battery staple";

test("demo mode still signs in as sindhu", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByTestId("demo-actors")).toContainText("sindhu");
  await page.screenshot({ path: "/opt/cursor/artifacts/auth-password.png", fullPage: true });
  await page.getByTestId("signin-actor").fill("sindhu");
  await page.getByTestId("signin-password").fill("nexora-demo-2026");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("screen-dashboard")).toBeVisible();
});

test("magic link and two-factor sign-in", async ({ page, request }) => {
  const actorId = `mail-${Date.now().toString(36)}`;
  const email = `${actorId}@example.com`;
  const signup = await request.post(`${API}/auth/signup`, {
    data: { actorId, email, password: PASSWORD },
  });
  expect(signup.ok()).toBeTruthy();

  await page.goto("/studio");
  await page.getByTestId("signin-magic-toggle").click();
  await page.screenshot({ path: "/opt/cursor/artifacts/auth-magic-link.png", fullPage: true });
  await page.getByTestId("magic-email").fill(email);
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-notice")).toContainText("If an account exists");

  const mailbox = await request.get(`${API}/auth/dev/mailbox`);
  expect(mailbox.ok()).toBeTruthy();
  const messages = (await mailbox.json()) as { messages: Array<{ text: string; to: string }> };
  const message = messages.messages.find((item) => item.to === email);
  const token = /magic=([A-Za-z0-9-]+)/.exec(message?.text ?? "")?.[1];
  expect(token).toBeTruthy();

  await page.goto(`/studio?magic=${token}`);
  await expect(page.getByLabel(`Account ${actorId}`)).toBeVisible();
  await page.getByLabel(`Account ${actorId}`).click();
  await page.getByTestId("open-2fa").click();
  await expect(page.getByTestId("screen-2fa")).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/auth-2fa.png", fullPage: true });
  const secret = (await page.getByTestId("totp-secret").textContent())?.trim() ?? "";
  await page.getByTestId("totp-confirm").fill(totpCode(secret));
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  const recovery =
    (await page.getByTestId("recovery-codes").locator("li").first().textContent())?.trim() ?? "";

  await page.getByRole("button", { name: "Close" }).click();
  await page.getByLabel(`Account ${actorId}`).click();
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("signin-actor")).toBeVisible();

  await page.getByTestId("signin-actor").fill(actorId);
  await page.getByTestId("signin-password").fill(PASSWORD);
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-otp")).toBeVisible();
  await page.getByTestId("signin-otp").fill(totpCode(secret));
  await page.getByTestId("signin-submit").click();
  await expect(page.getByLabel(`Account ${actorId}`)).toBeVisible();

  await page.getByLabel(`Account ${actorId}`).click();
  await page.getByTestId("sign-out").click();
  await page.getByTestId("signin-actor").fill(actorId);
  await page.getByTestId("signin-password").fill(PASSWORD);
  await page.getByTestId("signin-submit").click();
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByTestId("signin-otp").fill(recovery);
  await page.getByTestId("signin-submit").click();
  await expect(page.getByLabel(`Account ${actorId}`)).toBeVisible();
});

function totpCode(secret: string, now = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/=+$/g, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
