"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { readDataSource, type DataSourceKind } from "../data-source";
import { productSections } from "../product-nav";
import {
  IDENTITY_TOGGLE_LABEL,
  IdentityDrawer,
  IdentityGate,
  useIdentity,
  type SignedSession,
} from "../identity";
import { OpenCompany } from "../open-company";
import {
  AppShell,
  EngineLine,
  identityContext,
  InspectorSection,
  type ContextItem,
} from "../shell";
import {
  PLATFORM_ADMIN_ACTOR,
  listAccounts,
  listEntities,
  listPeriods,
  provisionTenant,
  type Account,
  type ApiResult,
  type Entity,
  type Period,
  type Session,
  type Tenant,
} from "./api";
import {
  readStoredSelection,
  readTabParam,
  sessionKey,
  useAction,
  useResource,
  writeStoredSelection,
  writeTabParam,
} from "./hooks";
import { AccountsPanel } from "./panels/accounts-panel";
import { EntitiesPanel } from "./panels/entities-panel";
import { JournalsPanel } from "./panels/journals-panel";
import { PeriodsPanel } from "./panels/periods-panel";
import { StatementsPanel } from "./panels/statements-panel";
import { ErrorNotice, Field, StatusBadge } from "./ui";

type Tab = "entities" | "accounts" | "periods" | "journals" | "statements";
type Needs = "none" | "entity" | "period";

const TABS: readonly { readonly id: Tab; readonly label: string; readonly needs: Needs }[] = [
  { id: "entities", label: "Entities", needs: "none" },
  { id: "accounts", label: "Chart of accounts", needs: "entity" },
  { id: "periods", label: "Periods", needs: "entity" },
  { id: "journals", label: "Journals", needs: "period" },
  { id: "statements", label: "Statements", needs: "period" },
];

function isTab(value: string | null): value is Tab {
  return TABS.some((candidate) => candidate.id === value);
}

function noRows<T>(): Promise<ApiResult<readonly T[]>> {
  return Promise.resolve({ ok: true, status: 200, data: [] });
}

export default function BooksPage() {
  const identity = useIdentity();
  const [initialTab, setInitialTab] = useState<Tab>("entities");
  const [identityOpen, setIdentityOpen] = useState(false);

  useEffect(() => {
    const tab = readTabParam();
    if (isTab(tab)) setInitialTab(tab);
  }, []);

  return (
    <IdentityGate area="books" identity={identity}>
      {(session, signed) => {
        const identityToggle = (
          <Button
            type="button"
            variant="ghost"
            aria-expanded={identityOpen}
            onClick={() => setIdentityOpen((open) => !open)}
          >
            {identityOpen ? "Hide identity" : IDENTITY_TOGGLE_LABEL}
          </Button>
        );
        const drawer =
          identityOpen || session.tenantId.length === 0 ? (
            <IdentityDrawer key={`identity:${sessionKey(session)}`} identity={identity} />
          ) : null;

        if (session.tenantId.length === 0) {
          return (
            <AppShell
              area="books"
              section="Open company"
              context={identityContext(session)}
              drawer={drawer}
            >
              {signed && !signed.platformAdmin ? (
                <OpenCompany session={session} selectTenant={identity.selectTenant} />
              ) : (
                <ProvisionPanel
                  session={session}
                  signed={signed}
                  onOpen={async (tenant) => {
                    await identity.selectTenant(tenant.tenantId, tenant.homeRegion);
                  }}
                />
              )}
            </AppShell>
          );
        }

        return (
          <Workspace
            key={`books:${sessionKey(session)}:${initialTab}`}
            session={session}
            initialTab={initialTab}
            contextActions={identityToggle}
            drawer={drawer}
          />
        );
      }}
    </IdentityGate>
  );
}

function ProvisionPanel({
  session,
  signed,
  onOpen,
}: {
  session: Session;
  signed: SignedSession | null;
  onOpen: (tenant: Tenant) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [homeRegion, setHomeRegion] = useState(session.region);
  const [ownerActorId, setOwnerActorId] = useState(session.actorId);
  const [formError, setFormError] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<Tenant | null>(null);
  const action = useAction();
  const sessionMode = signed !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const owner = ownerActorId.trim();
    if (name.trim().length === 0 || homeRegion.trim().length === 0 || owner.length === 0) {
      setFormError("Tenant name, home region, and owner are required.");
      return;
    }
    setFormError(null);
    const tenant = await action.run(() =>
      provisionTenant(session, {
        name: name.trim(),
        homeRegion: homeRegion.trim(),
        ownerActorId: owner,
      }),
    );
    if (tenant === null) return;
    if (owner === session.actorId) {
      await onOpen(tenant);
    } else {
      setProvisioned(tenant);
    }
  }

  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>Provision a tenant</h1>
          <p>
            {sessionMode ? (
              <>
                You are a platform administrator. The kernel provisions the tenant in{" "}
                <code>{session.region}</code> and makes the named actor its owner; that actor must
                already be registered.
              </>
            ) : (
              <>
                No tenant is set for this session. Provisioning runs as{" "}
                <code>{PLATFORM_ADMIN_ACTOR}</code> through dev headers and makes the named actor
                the owner.
              </>
            )}
          </p>
        </div>
      </header>
      <form className="form-card" onSubmit={submit}>
        <div className="form-row">
          <Field label="Tenant name">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
          </Field>
          <Field label="Owner actor">
            <Input
              value={ownerActorId}
              onChange={(event) => setOwnerActorId(event.target.value)}
              className="input-medium"
            />
          </Field>
          <Field label="Home region">
            <Input
              value={homeRegion}
              onChange={(event) => setHomeRegion(event.target.value)}
              className="input-medium"
              readOnly={sessionMode}
            />
          </Field>
          <Button type="submit" disabled={action.state.pending}>
            {action.state.pending ? "Provisioning…" : "Provision tenant"}
          </Button>
        </div>
        {formError ? <p className="form-error">{formError}</p> : null}
        {action.state.error ? (
          <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} />
        ) : null}
        {provisioned ? (
          <p className="notice notice-info" role="status">
            Provisioned <code>{provisioned.tenantId}</code> for <code>{ownerActorId.trim()}</code>.
            The owner signs in and opens it by ID.
          </p>
        ) : null}
      </form>
    </section>
  );
}

function Workspace({
  session,
  initialTab,
  contextActions,
  drawer,
}: {
  session: Session;
  initialTab: Tab;
  contextActions: ReactNode;
  drawer: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sourceKind, setSourceKind] = useState<DataSourceKind | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(
    () => readStoredSelection(session.tenantId).entityId,
  );
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(
    () => readStoredSelection(session.tenantId).periodId,
  );
  const base = sessionKey(session);

  useEffect(() => {
    setSourceKind(readDataSource().kind);
  }, []);

  useEffect(() => {
    writeStoredSelection(session.tenantId, {
      entityId: selectedEntityId,
      periodId: selectedPeriodId,
    });
  }, [session.tenantId, selectedEntityId, selectedPeriodId]);

  const entities = useResource(`${base}|entities`, () => listEntities(session));
  const entity: Entity | null =
    entities.resource.status === "ready"
      ? (entities.resource.data.find((row) => row.entityId === selectedEntityId) ?? null)
      : null;

  const accounts = useResource(entity ? `${base}|accounts|${entity.entityId}` : null, () =>
    entity ? listAccounts(session, entity.entityId) : noRows<Account>(),
  );
  const periods = useResource(entity ? `${base}|periods|${entity.entityId}` : null, () =>
    entity ? listPeriods(session, entity.entityId) : noRows<Period>(),
  );
  const period: Period | null =
    periods.resource.status === "ready"
      ? (periods.resource.data.find((row) => row.periodId === selectedPeriodId) ?? null)
      : null;

  function enabled(needs: Needs): boolean {
    if (needs === "entity") return entity !== null;
    if (needs === "period") return entity !== null && period !== null;
    return true;
  }

  const activeTab = TABS.find((candidate) => candidate.id === tab);
  const effectiveTab: Tab = activeTab && enabled(activeTab.needs) ? tab : "entities";
  const effectiveLabel =
    TABS.find((candidate) => candidate.id === effectiveTab)?.label ?? "Entities";

  function selectTab(next: string) {
    if (!isTab(next)) return;
    setTab(next);
    writeTabParam(next);
  }

  const entityCount = entities.resource.status === "ready" ? entities.resource.data.length : null;
  const accountCount = accounts.resource.status === "ready" ? accounts.resource.data.length : null;
  const periodCount = periods.resource.status === "ready" ? periods.resource.data.length : null;
  const counts: Partial<Record<Tab, number | null>> = {
    entities: entityCount,
    accounts: entity ? accountCount : null,
    periods: entity ? periodCount : null,
  };

  const context: ContextItem[] = [
    {
      label: "Entity",
      value: entity ? entity.legalName : <span className="ctx-empty">Not selected</span>,
      title: entity?.entityId,
    },
    {
      label: "Period",
      value: period ? (
        <>
          <span className="figure">
            {period.startDate} → {period.endDate}
          </span>
          <StatusBadge status={period.status} />
        </>
      ) : (
        <span className="ctx-empty">Not selected</span>
      ),
      title: period?.periodId,
    },
    {
      label: "Currency",
      value: entity ? entity.functionalCurrency : <span className="ctx-empty">—</span>,
    },
    ...identityContext(session),
  ];

  return (
    <AppShell
      area="books"
      section={effectiveLabel}
      sections={[
        ...productSections(sourceKind),
        {
          label: "Ledger detail",
          items: TABS.map((candidate) => {
            const count = counts[candidate.id];
            return {
              id: candidate.id,
              label: candidate.label,
              lockedReason: enabled(candidate.needs)
                ? null
                : candidate.needs === "entity"
                  ? "Select an entity first"
                  : "Select an entity and a period first",
              meta:
                typeof count === "number" ? (
                  <span className="muted small figure">{count}</span>
                ) : undefined,
            };
          }),
        },
      ]}
      activeSection={effectiveTab === "statements" ? "financials" : effectiveTab}
      onSection={selectTab}
      railNote={
        entity === null
          ? "Select an entity to unlock accounts and periods."
          : period === null
            ? "Select a period to unlock journals and statements."
            : "All sections are available for this period."
      }
      context={context}
      contextActions={contextActions}
      drawer={drawer}
      inspectorLabel="Selection inspector"
      inspector={
        <BooksInspector
          session={session}
          entity={entity}
          period={period}
          accountCount={accountCount}
          onOpen={selectTab}
        />
      }
    >
      {effectiveTab === "entities" ? (
        <EntitiesPanel
          session={session}
          entities={entities.resource}
          selectedEntityId={entity?.entityId ?? null}
          onSelect={(entityId) => {
            setSelectedEntityId(entityId);
            setSelectedPeriodId(null);
          }}
          onChanged={entities.reload}
        />
      ) : null}
      {effectiveTab === "accounts" && entity ? (
        <AccountsPanel
          session={session}
          entity={entity}
          accounts={accounts.resource}
          onChanged={() => {
            accounts.reload();
            entities.reload();
          }}
        />
      ) : null}
      {effectiveTab === "periods" && entity ? (
        <PeriodsPanel
          session={session}
          entity={entity}
          periods={periods.resource}
          selectedPeriodId={period?.periodId ?? null}
          onSelect={setSelectedPeriodId}
          onChanged={periods.reload}
        />
      ) : null}
      {effectiveTab === "journals" && entity && period ? (
        <JournalsPanel
          key={`${entity.entityId}|${period.periodId}`}
          session={session}
          entity={entity}
          period={period}
          accounts={accounts.resource}
        />
      ) : null}
      {effectiveTab === "statements" && entity && period ? (
        <StatementsPanel session={session} entity={entity} period={period} />
      ) : null}
    </AppShell>
  );
}

function BooksInspector({
  session,
  entity,
  period,
  accountCount,
  onOpen,
}: {
  session: Session;
  entity: Entity | null;
  period: Period | null;
  accountCount: number | null;
  onOpen: (tab: Tab) => void;
}) {
  const steps: readonly { readonly label: string; readonly done: boolean; readonly tab: Tab }[] = [
    {
      label: entity ? `Entity: ${entity.legalName}` : "Select or create an entity",
      done: entity !== null,
      tab: "entities",
    },
    {
      label:
        accountCount && accountCount > 0
          ? `${accountCount} accounts in the chart`
          : "Add accounts to the chart",
      done: accountCount !== null && accountCount > 0,
      tab: "accounts",
    },
    {
      label: period ? `Period ${period.startDate} → ${period.endDate}` : "Select or open a period",
      done: period !== null,
      tab: "periods",
    },
  ];

  return (
    <>
      <InspectorSection title="Books path">
        <ul className="checklist">
          {steps.map((step) => (
            <li key={step.tab} className={step.done ? "checklist-done" : undefined}>
              <span className="checklist-mark" aria-hidden="true">
                {step.done ? "✓" : ""}
              </span>
              <span className="sr-only">{step.done ? "Done:" : "To do:"}</span>
              <span>{step.label}</span>
            </li>
          ))}
        </ul>
        {period ? (
          <div className="row-actions" style={{ marginTop: "0.75rem" }}>
            <Button type="button" variant="outline" onClick={() => onOpen("journals")}>
              Journals
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpen("statements")}>
              Statements
            </Button>
          </div>
        ) : null}
      </InspectorSection>

      <InspectorSection title="Selection">
        <dl className="kv kv-stack">
          <dt>Tenant ID</dt>
          <dd>
            <code className="hash-wrap">{session.tenantId}</code>
          </dd>
          <dt>Entity ID</dt>
          <dd>
            {entity ? (
              <code className="hash-wrap">{entity.entityId}</code>
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
          <dt>Period ID</dt>
          <dd>
            {period ? (
              <code className="hash-wrap">{period.periodId}</code>
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
          <dt>Period status</dt>
          <dd>
            {period ? <StatusBadge status={period.status} /> : <span className="muted">—</span>}
          </dd>
        </dl>
      </InspectorSection>

      <InspectorSection title="Kernel">
        <dl className="kv kv-stack">
          <dt>Engine version</dt>
          <dd>
            <EngineLine />
          </dd>
        </dl>
        <p className="inspector-note">
          Totals, balances, and statements come from the kernel. Each statement run shows its input
          hash beside the figures.
        </p>
      </InspectorSection>

      {period ? (
        <InspectorSection title="Next">
          <p className="inspector-note" style={{ marginTop: 0 }}>
            When the books for this period are ready, draft and publish a financial state.
          </p>
          <p style={{ margin: "0.5rem 0 0" }}>
            <Link href="/program?tab=publish" className="text-link">
              Publish a financial state →
            </Link>
          </p>
        </InspectorSection>
      ) : null}
    </>
  );
}
