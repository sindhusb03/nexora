import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getIngestionClient } from "../app/review/client";
import { DetailView } from "../app/review/detail-view";
import { createMockIngestionClient, memoryStore } from "../app/review/mock-client";
import { ReviewShell } from "../app/review/shell";
import {
  fetchAuthConfig,
  fetchSession,
  listCompanies,
  login,
  selectTenant,
} from "../app/studio/api";
import type { CompanyCard, SessionView } from "../app/studio/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../app/studio/api", () => ({
  fetchAuthConfig: vi.fn(),
  fetchSession: vi.fn(),
  listCompanies: vi.fn(),
  login: vi.fn(),
  selectTenant: vi.fn(),
}));
vi.mock("../app/review/client", () => ({
  getIngestionClient: vi.fn(),
  isMockIngestion: () => true,
}));

const tenantless: SessionView = {
  actorId: "sindhu",
  tenantId: null,
  region: "us-east-1",
  roles: [],
  platformAdmin: false,
  csrfToken: "login-csrf",
};
const active: SessionView = {
  ...tenantless,
  tenantId: "company-one",
  roles: ["controller"],
  csrfToken: "active-csrf",
};
const company: CompanyCard = {
  tenantId: "company-one",
  name: "Company One",
  region: "us-east-1",
  status: "active",
};

async function renderReview() {
  let now = Date.parse("2026-09-30T12:00:00.000Z");
  const client = createMockIngestionClient({ now: () => now, store: memoryStore() });
  const uploaded = await client.upload(
    {
      files: [
        { fileName: "header.csv", mediaType: "text/csv", byteLength: 1, contentBase64: "QQ==" },
      ],
      idempotencyKey: "shell-upload",
    },
    "active-csrf",
  );
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  now += 2_000;
  const listed = await client.getExceptions(uploaded.value.id);
  if (!listed.ok) throw new Error(listed.error.message);
  const empty = listed.value.find(
    (item) => item.type === "header_as_value" && item.values.actual === null,
  )!;
  vi.mocked(getIngestionClient).mockReturnValue(client);
  render(
    <ReviewShell>
      <DetailView jobId={uploaded.value.id} exceptionId={empty.id} />
    </ReviewShell>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchSession).mockResolvedValue(tenantless);
  vi.mocked(fetchAuthConfig).mockResolvedValue({
    region: "us-east-1",
    demoMode: true,
    signupAllowed: false,
    oidcProviders: [],
  });
  vi.mocked(login).mockResolvedValue({ kind: "session", session: tenantless });
  vi.mocked(listCompanies).mockResolvedValue([company]);
  vi.mocked(selectTenant).mockResolvedValue(active);
});
afterEach(cleanup);

describe("review shell company activation", () => {
  it("activates the sole company after direct sign-in and enables resolution actions", async () => {
    vi.mocked(fetchSession).mockResolvedValue(null);
    await renderReview();
    fireEvent.click(await screen.findByRole("button", { name: "Open the company" }));
    const accept = await screen.findByRole("button", { name: "Accept", exact: true });
    expect(accept).toBeEnabled();
    expect(listCompanies).toHaveBeenCalledWith("login-csrf");
    expect(selectTenant).toHaveBeenCalledWith("login-csrf", "company-one");
    fireEvent.click(accept);
    fireEvent.click(screen.getByTestId("confirm-resolution"));
    expect(await screen.findByText("Accepted", { exact: true })).toBeInTheDocument();
  });

  it("activates an existing tenantless session before showing review actions", async () => {
    let finish!: (session: SessionView) => void;
    vi.mocked(selectTenant).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderReview();
    await waitFor(() => expect(selectTenant).toHaveBeenCalled());
    expect(screen.queryByTestId("screen-detail")).not.toBeInTheDocument();
    finish(active);
    expect(await screen.findByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  });

  it("offers a company picker and activates only the chosen company", async () => {
    vi.mocked(listCompanies).mockResolvedValue([
      company,
      { ...company, tenantId: "company-two", name: "Company Two" },
    ]);
    vi.mocked(selectTenant).mockResolvedValue({ ...active, tenantId: "company-two" });
    await renderReview();
    const choice = await screen.findByRole("button", { name: "Company Two" });
    expect(screen.getByRole("heading", { name: "Choose a company" })).toBeInTheDocument();
    expect(selectTenant).not.toHaveBeenCalled();
    expect(screen.queryByTestId("screen-detail")).not.toBeInTheDocument();
    fireEvent.click(choice);
    expect(await screen.findByRole("button", { name: "Accept", exact: true })).toBeEnabled();
    expect(selectTenant).toHaveBeenCalledWith("login-csrf", "company-two");
  });

  it("explains missing company access and links to Studio", async () => {
    vi.mocked(listCompanies).mockResolvedValue([]);
    await renderReview();
    expect(await screen.findByText(/No companies are available/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Studio" })).toHaveAttribute("href", "/studio");
    expect(screen.queryByTestId("screen-detail")).not.toBeInTheDocument();
    expect(selectTenant).not.toHaveBeenCalled();
  });

  it("keeps MFA signed out with the Studio handoff", async () => {
    vi.mocked(fetchSession).mockResolvedValue(null);
    vi.mocked(login).mockResolvedValue({ kind: "mfa", challengeId: "challenge" });
    await renderReview();
    fireEvent.click(await screen.findByRole("button", { name: "Open the company" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/second factor.*studio/);
    expect(screen.getByRole("heading", { name: /Sign in to review/ })).toBeInTheDocument();
    expect(listCompanies).not.toHaveBeenCalled();
    expect(selectTenant).not.toHaveBeenCalled();
    expect(screen.queryByTestId("screen-detail")).not.toBeInTheDocument();
  });

  it("keeps review gated on activation failure and allows retry", async () => {
    vi.mocked(selectTenant).mockRejectedValueOnce(new Error("Company activation failed"));
    await renderReview();
    expect(await screen.findByRole("alert")).toHaveTextContent("Company activation failed");
    expect(screen.queryByTestId("screen-detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Company One" }));
    expect(await screen.findByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  });

  it("distinguishes company lookup failure from no access and allows retry", async () => {
    vi.mocked(listCompanies).mockRejectedValueOnce(new Error("Company service unavailable"));
    await renderReview();
    expect(await screen.findByRole("alert")).toHaveTextContent("Company service unavailable");
    expect(screen.queryByText(/No companies are available/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("screen-detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  });

  it("preserves an active viewer session without switching companies or granting permissions", async () => {
    vi.mocked(fetchSession).mockResolvedValue({ ...active, roles: ["viewer"] });
    await renderReview();
    expect(await screen.findByRole("button", { name: "Accept", exact: true })).toBeDisabled();
    expect(listCompanies).not.toHaveBeenCalled();
    expect(selectTenant).not.toHaveBeenCalled();
  });
});
