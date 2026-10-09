import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLegalEntity,
  fetchSession,
  listCompanies,
  provisionTenant,
  selectTenant,
} from "../app/studio/api";
import { StudioApp } from "../app/studio/studio-app";
import type { SessionView } from "../app/studio/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../app/studio/charts", () => ({
  Chart: () => <div role="img" />,
}));
vi.mock("../app/studio/api", () => ({
  ApiFailure: class ApiFailure extends Error {
    readonly status = 0;
  },
  askCopilot: vi.fn(),
  decideProposal: vi.fn(),
  fetchPlatform: vi.fn(),
  confirmTotp: vi.fn(),
  consumeMagicLink: vi.fn(),
  createLegalEntity: vi.fn(),
  disableTotp: vi.fn(),
  enrollTotp: vi.fn(),
  fetchAuthConfig: vi.fn(),
  fetchSession: vi.fn(),
  fetchWorkspace: vi.fn(),
  grantSupport: vi.fn(),
  inviteMember: vi.fn(),
  listCompanies: vi.fn(),
  listLegalEntities: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  provisionTenant: vi.fn(),
  requestMagicLink: vi.fn(),
  verifySecondFactor: vi.fn(),
  saveForecast: vi.fn(),
  selectTenant: vi.fn(),
  setFlag: vi.fn(),
  setTenantStatus: vi.fn(),
}));

const fresh: SessionView = {
  actorId: "ada",
  tenantId: null,
  region: "us-east-1",
  roles: [],
  platformAdmin: false,
  csrfToken: "csrf-1",
};

const selected: SessionView = {
  ...fresh,
  tenantId: "22222222-2222-4222-8222-222222222222",
  roles: ["owner"],
  csrfToken: "csrf-2",
};

beforeEach(() => {
  vi.mocked(fetchSession).mockResolvedValue(fresh);
  vi.mocked(listCompanies).mockResolvedValue([]);
  vi.mocked(provisionTenant).mockResolvedValue({
    tenantId: selected.tenantId ?? "",
    homeRegion: "us-east-1",
    name: "Harbor Analytics",
  });
  vi.mocked(selectTenant).mockResolvedValue(selected);
  vi.mocked(createLegalEntity).mockResolvedValue({
    entityId: "33333333-3333-4333-8333-333333333333",
    legalName: "Harbor Analytics",
    functionalCurrency: "INR",
  });
});

afterEach(() => {
  cleanup();
});

describe("studio first sign-in", () => {
  it("opens the company the kernel recorded", async () => {
    render(<StudioApp />);
    expect(await screen.findByTestId("first-run")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Account ada" }));
    expect(screen.getByTestId("open-2fa")).toBeInTheDocument();
    expect(screen.getByTestId("sign-out")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("company-name"), { target: { value: "Harbor Analytics" } });
    fireEvent.click(screen.getByTestId("first-run-next"));
    fireEvent.change(screen.getByTestId("base-currency"), { target: { value: "INR" } });
    fireEvent.click(screen.getByTestId("first-run-next"));
    expect(screen.getByTestId("fye-month")).toHaveValue("3");
    fireEvent.click(screen.getByTestId("first-run-submit"));

    const home = await screen.findByTestId("company-home");
    expect(home).toHaveTextContent("Harbor Analytics");
    expect(home).toHaveTextContent("INR");
    expect(home).toHaveTextContent("31 March");
    expect(provisionTenant).toHaveBeenCalledWith("csrf-1", {
      name: "Harbor Analytics",
      homeRegion: "us-east-1",
      ownerActorId: "ada",
    });
    expect(selectTenant).toHaveBeenCalledWith("csrf-1", selected.tenantId);
    expect(createLegalEntity).toHaveBeenCalledWith("csrf-2", {
      legalName: "Harbor Analytics",
      functionalCurrency: "INR",
      fiscalYearEndMonth: 3,
      fiscalYearEndDay: 31,
    });
  });
});
