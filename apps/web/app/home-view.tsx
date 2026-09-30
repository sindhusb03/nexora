"use client";

import { Button } from "@/components/ui/button";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { Session } from "./books/api";
import {
  EMPTY_SOURCE,
  readDataSource,
  smartLedgerApplies,
  type DataSourceState,
} from "./data-source";
import { SignInPanel, useIdentity } from "./identity";
import { OpenCompany } from "./open-company";
import { productSections } from "./product-nav";
import { MetricTile, StatusBadge, SuggestedBadge } from "./books/ui";
import { Insights } from "./insights";
import { SmartLedger } from "./smart-ledger";
import { AppShell, identityContext, InspectorSection } from "./shell";
import { UploadMap } from "./upload-map";

export interface KernelHealth {
  readonly status: string;
  readonly service: string;
  readonly engineVersion: string;
}

const MAIN_PATH = [
  {
    step: 1,
    title: "Upload and map",
    body: "Bank or trial balance opens Smart Ledger. Financial statements from a ledger system or Excel stay structured.",
    href: "/classic?section=upload",
    cta: "Choose a source",
  },
  {
    step: 2,
    title: "Publish a financial state",
    body: "Draft a state, move it through review and approval, then publish with a second actor. The state hash stays fixed.",
    href: "/program?tab=publish",
    cta: "Open publish",
  },
  {
    step: 3,
    title: "Run a valuation",
    body: "Run the DCF on the server and read enterprise value and equity value with the run id, input hash, and engine version.",
    href: "/program?tab=valuation",
    cta: "Open valuation",
  },
  {
    step: 4,
    title: "Freeze a board pack",
    body: "Combine the published state and the published valuation into a pack with its own cutoff and hash.",
    href: "/program?tab=board",
    cta: "Open board pack",
  },
] as const;

const WORKBENCH = [
  {
    tab: "group",
    label: "Group and FX",
    body: "Translation with an explicit CTA line and NCI attribution.",
  },
  {
    tab: "model",
    label: "Models and scenarios",
    body: "Server-evaluated grids; a downside leaves the base untouched.",
  },
  { tab: "capital", label: "Capital", body: "Debt roll-forward, cap table, and sources and uses." },
  {
    tab: "import",
    label: "Import and QoE",
    body: "Idempotent import batches and normalized results.",
  },
  { tab: "deal", label: "Deals", body: "Scenarios pinned to a published state hash." },
  { tab: "basis", label: "Reporting basis", body: "Local and group hashes stored side by side." },
] as const;

type HomeSection = "dashboard" | "upload" | "ledger" | "operations" | "admin" | "super" | "label";

function isHomeSection(value: string | null): value is Exclude<HomeSection, "dashboard"> {
  return (
    value === "upload" ||
    value === "ledger" ||
    value === "operations" ||
    value === "admin" ||
    value === "super" ||
    value === "label"
  );
}

const SIGNED_OUT: Session = { actorId: "", tenantId: "", region: "" };

export function HomeView({ health }: { health: KernelHealth | null }) {
  const identity = useIdentity();
  const session = identity.state.status === "ready" ? identity.state.session : SIGNED_OUT;
  const [source, setSource] = useState<DataSourceState>(EMPTY_SOURCE);
  const [hydrated, setHydrated] = useState(false);
  const requested = useSearchParams().get("section");
  const section: HomeSection = isHomeSection(requested) ? requested : "dashboard";

  useEffect(() => {
    setSource(readDataSource());
    setHydrated(true);
  }, []);

  const visibleSection: HomeSection =
    hydrated && section === "ledger" && !smartLedgerApplies(source.kind) ? "upload" : section;
  const sourceLabel =
    source.kind === "bank"
      ? "Bank"
      : source.kind === "trial_balance"
        ? "Trial balance"
        : source.kind === "financial_statements"
          ? "Financial statements"
          : "Not chosen";

  return (
    <AppShell
      area="home"
      section={visibleSection === "dashboard" ? undefined : sectionTitle(visibleSection)}
      sections={productSections(
        hydrated ? source.kind : section === "ledger" ? "trial_balance" : source.kind,
      )}
      activeSection={visibleSection === "dashboard" ? undefined : visibleSection}
      context={[
        { label: "Source", value: sourceLabel },
        ...identityContext(session),
        { label: "Entity", value: <span className="ctx-empty">Choose in Books</span> },
        { label: "Currency", value: <span className="ctx-empty">Per entity</span> },
      ]}
      contextActions={
        identity.state.status === "signed-out" ? (
          <Link href="/books" className="button-ghost">
            Sign in
          </Link>
        ) : identity.state.status === "ready" && identity.state.signed ? (
          <Button type="button" variant="ghost" onClick={() => void identity.signOut()}>
            Sign out
          </Button>
        ) : null
      }
      inspectorLabel="Kernel inspector"
      inspector={
        <>
          <InspectorSection title="Kernel">
            <dl className="kv kv-stack">
              <dt>Service</dt>
              <dd>{health ? health.service : "Unreachable"}</dd>
              <dt>Status</dt>
              <dd>{health ? health.status : "No engine response"}</dd>
              <dt>Engine version</dt>
              <dd>
                {health ? (
                  <code>{health.engineVersion}</code>
                ) : (
                  "Unavailable until the kernel responds"
                )}
              </dd>
            </dl>
            <p className="inspector-note">
              Every figure in this workspace is produced by the server-side Financial Kernel and
              shown exactly as returned.
            </p>
          </InspectorSection>
          <InspectorSection title="Lifecycle">
            <div className="row-actions">
              {["draft", "validated", "review", "approved", "published", "superseded"].map(
                (status) => (
                  <StatusBadge key={status} status={status} />
                ),
              )}
            </div>
            <p className="inspector-note">
              Published versions are immutable. Publishing appends a new version and records a
              second actor as checker.
            </p>
          </InspectorSection>
          <InspectorSection title="Assistant">
            <div className="row-actions">
              <SuggestedBadge />
            </div>
            <p className="inspector-note">
              Assistant output carries this marker. It stays a proposal until the kernel validates
              it and a person approves it.
            </p>
          </InspectorSection>
        </>
      }
    >
      {visibleSection === "upload" ? (
        <UploadMap session={session} source={source} onChange={setSource} />
      ) : null}
      {visibleSection === "ledger" ? (
        <SmartLedger session={session} source={source} onChange={setSource} />
      ) : null}
      {visibleSection === "operations" ? <Operations /> : null}
      {visibleSection === "admin" ? <Admin session={session} /> : null}
      {visibleSection === "super" ? <SuperAdmin health={health} /> : null}
      {visibleSection === "label" ? <WhiteLabel /> : null}
      {visibleSection === "dashboard" && identity.state.status === "loading" ? (
        <p className="muted loading">Checking session…</p>
      ) : null}
      {visibleSection === "dashboard" && identity.state.status === "signed-out" ? (
        <SignInPanel notice={identity.state.notice} onSignedIn={identity.signedIn} />
      ) : null}
      {visibleSection === "dashboard" &&
      identity.state.status === "ready" &&
      session.tenantId.length === 0 ? (
        <OpenCompany session={session} selectTenant={identity.selectTenant} />
      ) : null}
      {visibleSection === "dashboard" &&
      identity.state.status === "ready" &&
      session.tenantId.length > 0 ? (
        <>
          <Insights session={session} health={health} />

          <h2 className="section-title">Main path</h2>
          <div className="path-grid">
            {MAIN_PATH.map((item) => (
              <Link key={item.step} href={item.href} className="path-card">
                <span className="eyebrow">Step {item.step}</span>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
                <span className="text-link">{item.cta} →</span>
              </Link>
            ))}
          </div>

          <h2 className="section-title">Workbench</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Area</th>
                <th>What the kernel does</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {WORKBENCH.map((item) => (
                <tr key={item.tab}>
                  <td>
                    <strong>{item.label}</strong>
                  </td>
                  <td className="muted">{item.body}</td>
                  <td className="cell-action">
                    <Link href={`/program?tab=${item.tab}`} className="text-link">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </AppShell>
  );
}

function sectionTitle(section: HomeSection): string {
  switch (section) {
    case "upload":
      return "Upload and Map";
    case "ledger":
      return "Smart Ledger";
    case "operations":
      return "Operations";
    case "admin":
      return "Admin";
    case "super":
      return "Super admin";
    case "label":
      return "White label";
    default:
      return "Insights";
  }
}

function Operations() {
  const areas = [
    {
      title: "Accounts receivable",
      body: "Open invoices sit beside the books. A balance is shown when the kernel returns one.",
    },
    { title: "Accounts payable", body: "Vendor bills stay a schedule until a journal is posted." },
    {
      title: "Inventory",
      body: "Quantity and value stay separate. Value comes from a posted account.",
    },
    { title: "Payroll", body: "Payroll expense is a mapping on the ledger, then a journal." },
    { title: "Fixed assets", body: "Cost, depreciation, and net book value are kernel schedules." },
  ];
  return (
    <section className="panel">
      <header className="page-head">
        <div>
          <h1>Operations</h1>
          <p>
            Receivables, payables, inventory, payroll, and fixed assets. None of these screens
            invent a balance.
          </p>
        </div>
      </header>
      <div className="path-grid">
        {areas.map((area) => (
          <article key={area.title} className="path-card">
            <strong>{area.title}</strong>
            <p>{area.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Admin({ session }: { session: Session }) {
  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>Admin</h1>
          <p>Users, companies, and the audit trail for this tenant. Billing is not connected.</p>
        </div>
      </header>
      <dl className="kv">
        <dt>Actor</dt>
        <dd>{session.actorId || "—"}</dd>
        <dt>Region</dt>
        <dd>{session.region || "—"}</dd>
        <dt>Tenant</dt>
        <dd>{session.tenantId || "Not provisioned"}</dd>
      </dl>
      <p>
        <Link href="/books" className="text-link">
          Company setup in the ledger
        </Link>
      </p>
    </section>
  );
}

function SuperAdmin({ health }: { health: KernelHealth | null }) {
  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>Super admin</h1>
          <p>
            Tenants, feature flags, and kernel health. Flags are off until a deployment sets them.
          </p>
        </div>
      </header>
      <div className="metrics">
        <MetricTile
          label="Kernel"
          value={health ? health.status : null}
          small
          basis={health ? health.engineVersion : "Unreachable"}
        />
      </div>
      <ul>
        <li>Feature flag: live bank connection — off</li>
        <li>Feature flag: QuickBooks, Xero, NetSuite, Sage — off</li>
        <li>Feature flag: white-label host — off</li>
      </ul>
    </section>
  );
}

function WhiteLabel() {
  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>White label</h1>
          <p>
            A host can present this workspace under its own name. The kernel, hashes, and engine
            version stay visible.
          </p>
        </div>
      </header>
      <p className="muted">
        No brand host is configured. The product name on this deployment is Nexora.
      </p>
    </section>
  );
}
