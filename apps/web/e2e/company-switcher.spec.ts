import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const artifacts = process.env.NEXORA_E2E_ARTIFACTS;
const API = "http://127.0.0.1:8787";
const PASSWORD = "correct horse battery staple";

async function shot(page: Page, name: string): Promise<void> {
  if (!artifacts) return;
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/${name}`, fullPage: true });
}

interface SessionBody {
  readonly csrfToken: string;
  readonly actorId: string;
  readonly region: string;
}

async function api<T>(
  page: Page,
  path: string,
  csrf: string,
  body?: unknown,
  idempotency?: string,
): Promise<T> {
  return page.evaluate(
    async ({ apiBase, path: requestPath, csrf: token, body: payload, idempotency: key }) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-csrf-token": token,
      };
      if (key) headers["idempotency-key"] = key;
      const response = await fetch(`${apiBase}${requestPath}`, {
        method: payload === undefined ? "GET" : "POST",
        credentials: "include",
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const json = (await response.json().catch(() => null)) as T & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(json?.error?.message ?? `${requestPath} returned ${response.status}`);
      }
      return json;
    },
    { apiBase: API, path, csrf, body, idempotency },
  );
}

async function bookCompany(
  page: Page,
  session: SessionBody,
  input: { readonly name: string; readonly currency: string; readonly revenue: string },
): Promise<SessionBody> {
  const tenant = await api<{ tenantId: string }>(page, "/v1/tenants", session.csrfToken, {
    name: input.name,
    homeRegion: session.region,
    ownerActorId: session.actorId,
  });
  const selected = await api<SessionBody>(page, "/auth/session/tenant", session.csrfToken, {
    tenantId: tenant.tenantId,
  });
  const entity = await api<{ entityId: string }>(page, "/v1/entities", selected.csrfToken, {
    legalName: input.name,
    functionalCurrency: input.currency,
  });
  const cash = await api<{ accountId: string }>(page, "/v1/accounts", selected.csrfToken, {
    entityId: entity.entityId,
    code: "1000",
    name: "Cash",
    report: "asset",
    cashFlow: "cash",
  });
  const earnings = await api<{ accountId: string }>(page, "/v1/accounts", selected.csrfToken, {
    entityId: entity.entityId,
    code: "3000",
    name: "Retained earnings",
    report: "equity",
    cashFlow: "non_cash",
    retainedEarnings: true,
  });
  const revenue = await api<{ accountId: string }>(page, "/v1/accounts", selected.csrfToken, {
    entityId: entity.entityId,
    code: "4000",
    name: "Revenue",
    report: "revenue",
    cashFlow: "cfo",
  });
  const opening = await api<{ periodId: string }>(page, "/v1/periods", selected.csrfToken, {
    entityId: entity.entityId,
    startDate: "2026-01-01",
    endDate: "2026-01-31",
  });
  const current = await api<{ periodId: string }>(page, "/v1/periods", selected.csrfToken, {
    entityId: entity.entityId,
    startDate: "2026-09-01",
    endDate: "2026-09-30",
  });
  await api(
    page,
    "/v1/journals",
    selected.csrfToken,
    {
      entityId: entity.entityId,
      periodId: opening.periodId,
      currency: input.currency,
      sourceRef: "opening",
      lines: [
        { accountId: cash.accountId, debit: "1000.00", credit: "0.00" },
        { accountId: earnings.accountId, debit: "0.00", credit: "1000.00" },
      ],
    },
    `${input.name}-opening`,
  );
  await api(page, `/v1/periods/${opening.periodId}/close`, selected.csrfToken, {});
  await api(
    page,
    "/v1/journals",
    selected.csrfToken,
    {
      entityId: entity.entityId,
      periodId: current.periodId,
      currency: input.currency,
      sourceRef: "september",
      lines: [
        { accountId: cash.accountId, debit: input.revenue, credit: "0.00" },
        { accountId: revenue.accountId, debit: "0.00", credit: input.revenue },
      ],
    },
    `${input.name}-september`,
  );
  return selected;
}

test("the studio switcher lists both companies and changes the kernel figures", async ({
  page,
}) => {
  const actorId = `qa${Date.now().toString(36)}`;
  const signup = await page.request.post(`${API}/auth/signup`, {
    data: { actorId, email: `${actorId}@example.com`, password: PASSWORD },
  });
  expect(signup.ok()).toBeTruthy();

  await page.goto("/studio");
  await page.getByTestId("signin-actor").fill(actorId);
  await page.getByTestId("signin-password").fill(PASSWORD);
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("first-run")).toBeVisible();

  const session = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/auth/session`, { credentials: "include" });
    if (!response.ok) throw new Error("session was not readable");
    return (await response.json()) as SessionBody;
  }, API);

  const harborSession = await bookCompany(page, session, {
    name: "Harbor Clinic LLC",
    currency: "USD",
    revenue: "51000.00",
  });
  const atelierSession = await bookCompany(page, harborSession, {
    name: "Atelier Nord SAS",
    currency: "EUR",
    revenue: "18000.00",
  });
  await page.evaluate(
    async ({ apiBase, csrf }) => {
      const response = await fetch(`${apiBase}/auth/session/tenant`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ tenantId: null }),
      });
      if (!response.ok) throw new Error("the tenant could not be cleared");
    },
    { apiBase: API, csrf: atelierSession.csrfToken },
  );

  await page.goto("/studio");
  await expect(page.getByTestId("screen-dashboard")).toBeVisible();
  await expect(page.getByTestId("tenant-switch")).not.toContainText("No company");
  await page.getByTestId("tenant-switch").click();
  await expect(page.getByRole("menuitem", { name: /Harbor Clinic LLC/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Atelier Nord SAS/ })).toBeVisible();
  await shot(page, "company-switcher-open.png");
  await page.getByRole("menuitem", { name: /Harbor Clinic LLC/ }).click();
  await expect(page.getByTestId("tenant-switch")).toContainText("Harbor Clinic LLC");
  await expect(page.getByTestId("screen-dashboard")).toContainText("$51,000.00");
  await shot(page, "company-switcher-harbor.png");

  await page.getByTestId("tenant-switch").click();
  await page.getByRole("menuitem", { name: /Atelier Nord SAS/ }).click();
  await expect(page.getByTestId("tenant-switch")).toContainText("Atelier Nord SAS");
  await expect(page.getByTestId("screen-dashboard")).toContainText("€18,000.00");
  await expect(page.getByTestId("screen-dashboard")).not.toContainText("$51,000.00");
  await shot(page, "company-switcher-atelier.png");

  await page.getByTestId("nav-admin").click();
  await expect(page.getByTestId("screen-admin")).toContainText("Atelier Nord SAS");
  await expect(page.getByTestId(`member-${actorId}`)).toContainText("owner");
  await shot(page, "company-switcher-members.png");
});
