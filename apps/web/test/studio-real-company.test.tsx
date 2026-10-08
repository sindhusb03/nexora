import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSession, fetchWorkspace, listCompanies } from "../app/studio/api";
import { StudioApp } from "../app/studio/studio-app";
import type { SessionView, Workspace } from "../app/studio/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../app/studio/charts", () => ({
  Chart: () => <div role="img" />,
}));
vi.mock("../app/studio/api", () => ({
  ApiFailure: class ApiFailure extends Error {},
  askCopilot: vi.fn(),
  decideProposal: vi.fn(),
  fetchPlatform: vi.fn(),
  confirmTotp: vi.fn(),
  consumeMagicLink: vi.fn(),
  disableTotp: vi.fn(),
  enrollTotp: vi.fn(),
  fetchAuthConfig: vi.fn(),
  fetchSession: vi.fn(),
  fetchWorkspace: vi.fn(),
  grantSupport: vi.fn(),
  inviteMember: vi.fn(),
  listCompanies: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  requestMagicLink: vi.fn(),
  verifySecondFactor: vi.fn(),
  saveForecast: vi.fn(),
  selectTenant: vi.fn(),
  setFlag: vi.fn(),
  setTenantStatus: vi.fn(),
}));

const unavailable = { status: "unavailable" as const, reason: "no tenant plan data" };
const periodId = "11111111-1111-4111-8111-111111111111";

function row(key: string, label: string, section: string, minor: string, display: string) {
  return { key, label, section, values: [{ periodId, minor, display }] };
}

/** A posted company with the null plan panels the API returns when demo mode is off. */
const realCompany: Workspace = {
  engineVersion: "fe-kernel-0.2.1",
  permissions: { roles: ["owner"], canWrite: true, auditLocked: false },
  context: {
    tenantId: "22222222-2222-4222-8222-222222222222",
    tenantName: "Real customer",
    region: "us-east-1",
    entityId: "33333333-3333-4333-8333-333333333333",
    entityName: "Real entity",
    currency: "USD",
    periodId,
    periodLabel: "2024-12-31",
    scenario: "Base",
  },
  latest: {
    inputHash: "abc123def456",
    revenueMinor: "100",
    expensesMinor: "40",
    netIncomeMinor: "60",
    endingCashMinor: "60",
    assetsMinor: "60",
    liabilitiesMinor: "0",
    equityMinor: "60",
  },
  kpis: [
    {
      id: "revenue",
      label: "Revenue",
      minor: "100",
      display: "1.00",
      currency: "USD",
      lineage: { inputHash: "abc123def456", engineVersion: "fe-kernel-0.2.1", source: "kernel" },
    },
    {
      id: "normalized",
      label: "Normalized earnings",
      minor: null,
      display: null,
      currency: "USD",
      lineage: null,
      ...unavailable,
    },
  ],
  statements: {
    periods: [
      {
        periodId,
        label: "2024-12",
        inputHash: "abc123def456",
        engineVersion: "fe-kernel-0.2.1",
      },
    ],
    rows: [
      row("revenue", "Revenue", "income", "100", "1.00"),
      row("net", "Net income", "income", "60", "0.60"),
      row("assets", "Assets", "balance", "60", "0.60"),
      row("liabilities", "Liabilities", "balance", "0", "0.00"),
      row("equity", "Equity", "balance", "60", "0.60"),
      row("end", "Ending cash", "cash", "60", "0.60"),
    ],
  },
  journals: [],
  forecast: {
    ...unavailable,
    drivers: { revenueMinor: null, growthRate: null, grossMargin: null, opexMinor: null },
    scenarioGrowthRate: null,
    base: null,
    scenario: null,
  },
  cash: { ...unavailable, minimumCashMinor: null, base: null, downside: null },
  variance: { ...unavailable, engineVersion: null, inputHash: null, lines: [] },
  qoe: {
    ...unavailable,
    engineVersion: null,
    inputHash: null,
    reported: null,
    adjustmentsTotal: null,
    normalized: null,
    steps: [],
  },
  board: {
    title: "Real customer board pack",
    cutoff: "2024-12-31",
    stateHash: "abc123def456",
    sections: [
      {
        heading: "Performance",
        figures: [{ label: "Revenue", minor: "100", display: "1.00", inputHash: "abc123def456" }],
      },
      { heading: "Quality of earnings", figures: [] },
    ],
  },
  onboarding: {
    steps: [
      { id: "upload", label: "Upload trial balance and statements", state: "complete" },
      { id: "reconcile", label: "Reconciliation certificate", state: "unavailable" },
    ],
    certificate: {
      bookCash: { minor: "60", display: "0.60" },
      bankCash: null,
      difference: null,
      status: "unavailable",
      sourceDocument: null,
      engineVersion: "fe-kernel-0.2.1",
      inputHash: "abc123def456",
    },
  },
  approvals: [],
  documents: [],
  admin: { members: [], policies: [], audit: [], auditLocked: false },
  series: [
    {
      label: "2024-12",
      revenue: "100",
      netIncome: "60",
      cash: "60",
      revenueDelta: "0",
      netIncomeDelta: "0",
      cashDelta: "0",
    },
  ],
};

const session: SessionView = {
  actorId: "owner-1",
  tenantId: realCompany.context.tenantId,
  region: "us-east-1",
  roles: ["owner"],
  platformAdmin: false,
  csrfToken: "csrf-token",
};

beforeEach(() => {
  vi.mocked(fetchSession).mockResolvedValue(session);
  vi.mocked(listCompanies).mockResolvedValue([
    {
      tenantId: realCompany.context.tenantId,
      name: realCompany.context.tenantName,
      region: "us-east-1",
      status: "active",
    },
  ]);
  vi.mocked(fetchWorkspace).mockResolvedValue(realCompany);
});

afterEach(() => {
  cleanup();
});

describe("studio with a non-demo company", () => {
  it("renders kernel figures and unavailable plan panels instead of crashing", async () => {
    render(<StudioApp />);
    expect(await screen.findByTestId("screen-dashboard")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Real entity" })).toBeInTheDocument();
    expect(screen.getByTestId("kpi-unavailable")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("kpi-unavailable")).toHaveTextContent("no tenant plan data");

    fireEvent.click(screen.getByTestId("nav-forecast"));
    expect(await screen.findByTestId("screen-forecast")).toHaveTextContent("Forecast unavailable");
    expect(screen.getByTestId("screen-forecast")).toHaveTextContent("no tenant plan data");

    fireEvent.click(screen.getByTestId("nav-cash"));
    expect(await screen.findByTestId("screen-cash")).toHaveTextContent("Cash forecast unavailable");

    fireEvent.click(screen.getByTestId("nav-variance"));
    expect(await screen.findByTestId("screen-variance")).toHaveTextContent("Variance unavailable");

    fireEvent.click(screen.getByTestId("nav-qoe"));
    expect(await screen.findByTestId("screen-qoe")).toHaveTextContent(
      "Quality of earnings unavailable",
    );

    fireEvent.click(screen.getByTestId("nav-onboarding"));
    expect(await screen.findByTestId("screen-onboarding")).toBeInTheDocument();
    expect(screen.getByTestId("reconciliation")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("reconciliation")).toHaveTextContent("0.60");

    fireEvent.click(screen.getByTestId("nav-board"));
    expect(await screen.findByTestId("screen-board")).toHaveTextContent("Real customer board pack");
    expect(screen.getByTestId("screen-board")).toHaveTextContent("Unavailable for this company.");

    fireEvent.click(screen.getByTestId("nav-statements"));
    expect(await screen.findByTestId("screen-statements")).toHaveTextContent("Ending cash");
  });
});
