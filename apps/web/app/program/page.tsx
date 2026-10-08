"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  createAccount,
  createEntity,
  createPeriod,
  listEntities,
  listPeriods,
  provisionTenant,
  type Session,
} from "../books/api";
import {
  readProgramProgress,
  readStoredSelection,
  readTabParam,
  sessionKey,
  useAction,
  useResource,
  writeProgramProgress,
  writeStoredSelection,
  writeTabParam,
} from "../books/hooks";
import { ErrorNotice, Field, StatusBadge, SuggestedBadge } from "../books/ui";
import { readDataSource, type DataSourceKind } from "../data-source";
import {
  IDENTITY_TOGGLE_LABEL,
  IdentityDrawer,
  IdentityGate,
  selectSessionTenant,
  useIdentity,
  type Identity,
  type SignedSession,
} from "../identity";
import { productSections } from "../product-nav";
import {
  AppShell,
  EngineLine,
  identityContext,
  InspectorSection,
  type ContextItem,
} from "../shell";
import {
  decodeLineage,
  decodeReportPack,
  decodeSensitivity,
  decodeStateVersion as decodeStateMetadata,
  decodeValuationRun,
  decodeValuationVersion,
  field,
  kernelCall,
  type KernelRecord,
  type ReportPack,
  type SensitivityResult,
  type StateVersion,
  type ValuationRun,
  type VersionRef,
} from "./api";
import { GroupScreen } from "./group-screen";
import { BoardPanel, PublishPanel, ValuationPanel } from "./main-path";
import {
  AssistantPanel,
  BasisPanel,
  CapitalPanel,
  DealPanel,
  ImportPanel,
  ModelPanel,
  type RunCommand,
} from "./workbench";

type Tab =
  | "publish"
  | "valuation"
  | "board"
  | "group"
  | "model"
  | "capital"
  | "import"
  | "deal"
  | "basis"
  | "assistant";

type CalculatedStateVersion = StateVersion & {
  readonly netIncomeMinor: string | null;
  readonly currency: string | null;
};

function decodeStateVersion(
  data: KernelRecord,
  previous: CalculatedStateVersion | null,
): CalculatedStateVersion | null {
  const version = decodeStateMetadata(data, previous);
  return version
    ? {
        ...version,
        netIncomeMinor: field(data, "netIncomeMinor"),
        currency: field(data, "currency"),
      }
    : null;
}

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  publish: "Financial state",
  valuation: "Valuation",
  board: "Board pack",
  group: "Group and FX",
  model: "Models",
  capital: "Capital",
  import: "Import and QoE",
  deal: "Deals",
  basis: "Reporting basis",
  assistant: "Proposals",
};

const LOCAL_TABS: readonly Tab[] = ["publish", "group", "import", "basis", "assistant"];

const FIGURES = [
  "status",
  "calculationStatus",
  "stateHash",
  "engineVersion",
  "calculationRunId",
  "inputHash",
  "enterpriseValue",
  "equityValue",
  "closingMinor",
  "fullyDilutedShares",
  "normalized",
  "ctaMinor",
  "parentEquityMinor",
  "nciMinor",
  "outputHash",
  "localHash",
  "groupHash",
  "fileHash",
  "refusal",
  "code",
] as const;

function isTab(value: string | null): value is Tab {
  return value !== null && value in TAB_LABELS;
}

interface LastResponse {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly actorId: string;
  readonly data: KernelRecord;
}

export default function ProgramPage() {
  const identity = useIdentity();
  const [initialTab, setInitialTab] = useState<Tab>("publish");
  const [identityOpen, setIdentityOpen] = useState(false);

  useEffect(() => {
    const tab = readTabParam();
    if (isTab(tab)) setInitialTab(tab);
  }, []);

  return (
    <IdentityGate area="program" identity={identity}>
      {(session, signed) => (
        <ProgramWorkspace
          key={`program:${sessionKey(session)}:${initialTab}`}
          session={session}
          signed={signed}
          identity={identity}
          initialTab={initialTab}
          identityOpen={identityOpen}
          onToggleIdentity={() => setIdentityOpen((open) => !open)}
        />
      )}
    </IdentityGate>
  );
}

function ProgramWorkspace({
  session,
  signed,
  identity,
  initialTab,
  identityOpen,
  onToggleIdentity,
}: {
  session: Session;
  signed: SignedSession | null;
  identity: Identity;
  initialTab: Tab;
  identityOpen: boolean;
  onToggleIdentity: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sourceKind, setSourceKind] = useState<DataSourceKind | null>(null);
  const [entityId, setEntityId] = useState(
    () => readStoredSelection(session.tenantId).entityId ?? "",
  );
  const [periodId, setPeriodId] = useState(
    () => readStoredSelection(session.tenantId).periodId ?? "",
  );
  const [checkerId, setCheckerId] = useState("controller-1");
  const [checkerGranted, setCheckerGranted] = useState(false);
  const [stateVersion, setStateVersion] = useState<CalculatedStateVersion | null>(null);
  const [publishedStateId, setPublishedStateId] = useState("");
  const [valuationRun, setValuationRun] = useState<ValuationRun | null>(null);
  const [valuationVersion, setValuationVersion] = useState<VersionRef | null>(null);
  const [publishedValuationId, setPublishedValuationId] = useState("");
  const [makers, setMakers] = useState<{
    readonly state: string | null;
    readonly valuation: string | null;
  }>({ state: null, valuation: null });
  const [restored, setRestored] = useState(false);
  const [sensitivity, setSensitivity] = useState<SensitivityResult | null>(null);
  const [pack, setPack] = useState<ReportPack | null>(null);
  const [last, setLast] = useState<LastResponse | null>(null);
  const action = useAction();
  const base = sessionKey(session);
  const hasTenant = session.tenantId.length > 0;
  /** With a signed session the kernel records the signed-in actor as checker; dev headers can name one. */
  const publishAs = signed ? session.actorId : checkerId;

  useEffect(() => {
    if (!hasTenant) {
      setRestored(true);
      return;
    }
    const saved = readProgramProgress(session.tenantId);
    let cancelled = false;
    void (async () => {
      if (saved.stateId) {
        const result = await kernelCall(session, "GET", `/v1/financial-states/${saved.stateId}`);
        const version = result.ok ? decodeStateVersion(result.data, null) : null;
        if (!cancelled && result.ok && version) {
          setStateVersion(version);
          setMakers((current) => ({ ...current, state: field(result.data, "makerActorId") }));
        }
      }
      if (saved.valuationId) {
        const result = await kernelCall(session, "GET", `/v1/valuations/${saved.valuationId}`);
        const run = result.ok ? decodeValuationRun(result.data) : null;
        if (!cancelled && result.ok && run) {
          setValuationRun(run);
          setValuationVersion({
            id: run.valuationId,
            status: field(result.data, "status") ?? "draft",
            supersedesId: null,
          });
          setMakers((current) => ({ ...current, valuation: field(result.data, "makerActorId") }));
        }
      }
      if (cancelled) return;
      if (saved.publishedStateId) setPublishedStateId(saved.publishedStateId);
      if (saved.publishedValuationId) setPublishedValuationId(saved.publishedValuationId);
      setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
    // Restores once per mounted session; the workspace remounts when the session changes.
  }, []);

  useEffect(() => {
    if (!restored || !hasTenant) return;
    writeProgramProgress(session.tenantId, {
      stateId: stateVersion?.financialStateId ?? null,
      publishedStateId: publishedStateId || null,
      valuationId: valuationVersion?.id ?? valuationRun?.valuationId ?? null,
      publishedValuationId: publishedValuationId || null,
    });
  }, [
    restored,
    hasTenant,
    session.tenantId,
    stateVersion,
    publishedStateId,
    valuationVersion,
    valuationRun,
    publishedValuationId,
  ]);

  const entities = useResource(hasTenant ? `entities:${base}` : null, () => listEntities(session));
  const periods = useResource(
    hasTenant && entityId.length > 0 ? `periods:${base}:${entityId}` : null,
    () => listPeriods(session, entityId),
  );
  const entity =
    entities.resource.status === "ready"
      ? (entities.resource.data.find((row) => row.entityId === entityId) ?? null)
      : null;
  const period =
    periods.resource.status === "ready"
      ? (periods.resource.data.find((row) => row.periodId === periodId) ?? null)
      : null;

  useEffect(() => {
    setSourceKind(readDataSource().kind);
  }, []);

  useEffect(() => {
    if (hasTenant)
      writeStoredSelection(session.tenantId, {
        entityId: entityId || null,
        periodId: periodId || null,
      });
  }, [hasTenant, session.tenantId, entityId, periodId]);

  function selectTab(next: string) {
    if (!isTab(next)) return;
    setTab(next);
    writeTabParam(next);
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    actorId?: string,
    idempotencyKey?: string,
  ) {
    const data = await action.run(() =>
      kernelCall(session, method, path, body, { actorId, idempotencyKey }),
    );
    if (data)
      setLast({
        method,
        path,
        actorId: signed ? session.actorId : (actorId ?? session.actorId),
        data,
      });
    return data;
  }

  const run: RunCommand = (actorId, path, body, idempotencyKey) =>
    call("POST", path, body, actorId, idempotencyKey);
  const busy = action.state.pending;

  async function transitionState(to: string): Promise<boolean> {
    if (!stateVersion) return false;
    const data = await run(
      to === "published" ? publishAs : undefined,
      `/v1/financial-states/${stateVersion.financialStateId}/transition`,
      { to },
    );
    const next = data ? decodeStateVersion(data, stateVersion) : null;
    if (!next) return false;
    setStateVersion(next);
    if (next.status === "published") setPublishedStateId(next.financialStateId);
    return true;
  }

  async function transitionValuation(to: string): Promise<boolean> {
    const currentId = valuationVersion?.id ?? valuationRun?.valuationId;
    if (!currentId) return false;
    const data = await run(
      to === "published" ? publishAs : undefined,
      `/v1/valuations/${currentId}/transition`,
      { to },
    );
    const next = data ? decodeValuationVersion(data) : null;
    if (!next) return false;
    setValuationVersion(next);
    if (next.status === "published") setPublishedValuationId(next.id);
    return true;
  }

  const steps: readonly Step[] = [
    {
      tab: "publish",
      label: "Draft state",
      done: stateVersion !== null,
      detail: stateVersion ? <StatusBadge status={stateVersion.status} /> : "Not drafted",
    },
    {
      tab: "publish",
      label: "Approve state",
      done: stateVersion?.status === "approved" || stateVersion?.status === "published",
      detail: stateVersion ? `Now ${stateVersion.status}` : "Validate, review, approve",
    },
    {
      tab: "publish",
      label: "Publish state",
      done: publishedStateId.length > 0,
      detail: publishedStateId ? <StatusBadge status="published" /> : "Checker signs",
    },
    {
      tab: "valuation",
      label: "Run valuation",
      done: valuationRun?.calculationStatus === "succeeded",
      detail: valuationRun ? (
        <StatusBadge status={valuationRun.calculationStatus} />
      ) : (
        "DCF on the kernel"
      ),
    },
    {
      tab: "valuation",
      label: "Publish valuation",
      done: publishedValuationId.length > 0,
      detail: publishedValuationId ? (
        <StatusBadge status="published" />
      ) : valuationVersion ? (
        `Now ${valuationVersion.status}`
      ) : (
        "Checker signs"
      ),
    },
    {
      tab: "board",
      label: "Freeze board pack",
      done: pack !== null,
      detail: pack ? (
        <StatusBadge status={pack.status} />
      ) : publishedStateId && publishedValuationId ? (
        "Ready to freeze"
      ) : (
        "Needs both published"
      ),
    },
  ];

  const sections = [
    ...productSections(sourceKind),
    {
      label: "Kernel commands",
      items: LOCAL_TABS.map((id) => ({
        id,
        label: TAB_LABELS[id],
        lockedReason: hasTenant ? null : "Open a company first",
        meta:
          id === "assistant" ? (
            <span className="badge badge-violet" aria-label="Suggested content">
              AI
            </span>
          ) : undefined,
      })),
    },
  ];

  const context: ContextItem[] = [
    {
      label: "Entity",
      value: hasTenant ? (
        <select
          aria-label="Entity"
          value={entityId}
          onChange={(event) => {
            setEntityId(event.target.value);
            setPeriodId("");
          }}
        >
          <option value="">Select entity</option>
          {entities.resource.status === "ready"
            ? entities.resource.data.map((row) => (
                <option key={row.entityId} value={row.entityId}>
                  {row.legalName}
                </option>
              ))
            : null}
        </select>
      ) : (
        <span className="ctx-empty">—</span>
      ),
    },
    {
      label: "Period",
      value: hasTenant ? (
        <>
          <select
            aria-label="Period"
            value={periodId}
            onChange={(event) => setPeriodId(event.target.value)}
            disabled={entityId.length === 0}
          >
            <option value="">Select period</option>
            {periods.resource.status === "ready"
              ? periods.resource.data.map((row) => (
                  <option key={row.periodId} value={row.periodId}>
                    {row.startDate} → {row.endDate}
                  </option>
                ))
              : null}
          </select>
          {period ? <StatusBadge status={period.status} /> : null}
        </>
      ) : (
        <span className="ctx-empty">—</span>
      ),
    },
    {
      label: "Currency",
      value: entity ? entity.functionalCurrency : <span className="ctx-empty">—</span>,
    },
    {
      label: signed ? "Grant checker" : "Checker",
      title: signed
        ? "The actor to grant the controller role. Publishing always acts as the signed-in actor."
        : undefined,
      value: (
        <Input
          aria-label="Checker actor"
          value={checkerId}
          onChange={(event) => setCheckerId(event.target.value)}
          style={{ width: "8.5rem" }}
        />
      ),
    },
    ...identityContext(session),
  ];

  const scopeLabel =
    entity && period
      ? `${entity.legalName} · ${period.startDate} → ${period.endDate}`
      : "No entity and period selected";

  return (
    <AppShell
      area="program"
      section={hasTenant ? TAB_LABELS[tab] : "Open a company"}
      sections={sections}
      activeSection={tab}
      onSection={selectTab}
      railNote="Books keeps the ledger. These screens send commands to the kernel and display what it returns."
      context={context}
      contextActions={
        <Button
          type="button"
          variant="ghost"
          aria-expanded={identityOpen}
          onClick={onToggleIdentity}
        >
          {identityOpen ? "Hide identity" : IDENTITY_TOGGLE_LABEL}
        </Button>
      }
      drawer={
        identityOpen || !hasTenant ? (
          <IdentityDrawer key={`identity:${base}`} identity={identity} />
        ) : null
      }
      inspectorLabel="Kernel result inspector"
      inspector={
        <ProgramInspector
          stateVersion={stateVersion}
          valuationRun={valuationRun}
          valuationVersion={valuationVersion}
          pack={pack}
          last={last}
        />
      }
    >
      {!hasTenant ? (
        <Setup
          session={session}
          signed={signed}
          onReady={async (next, createdEntityId, createdPeriodId) => {
            writeStoredSelection(next.tenantId, {
              entityId: createdEntityId,
              periodId: createdPeriodId,
            });
            await identity.selectTenant(next.tenantId, next.region);
          }}
        />
      ) : (
        <>
          {tab === "publish" || tab === "valuation" || tab === "board" ? (
            <MainPathSteps steps={steps} current={tab} onOpen={selectTab} />
          ) : null}
          {action.state.error ? (
            <div style={{ marginBottom: "1rem" }}>
              <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} />
            </div>
          ) : null}

          {tab === "publish" ? (
            <PublishPanel
              disabled={busy}
              canDraft={entityId.length > 0 && periodId.length > 0}
              scopeLabel={scopeLabel}
              currency={entity?.functionalCurrency ?? "USD"}
              makerId={makers.state ?? session.actorId}
              checkerId={publishAs}
              grantActorId={checkerId}
              checkerGranted={checkerGranted}
              stateVersion={stateVersion}
              onDraft={async () => {
                const data = await run(undefined, "/v1/financial-states", {
                  entityId,
                  periodId,
                  basis: "us-gaap",
                });
                const next = data ? decodeStateVersion(data, null) : null;
                if (next) {
                  setStateVersion(next);
                  setMakers((current) => ({ ...current, state: session.actorId }));
                }
              }}
              onTransition={transitionState}
              onLineage={async () => {
                if (!stateVersion) return;
                // The lineage route lists outgoing edges; the predecessor holds the edge into this version.
                const anchor = stateVersion.supersedesId ?? stateVersion.financialStateId;
                await call("GET", `/v1/lineage/financial_state/${anchor}`);
              }}
              onGrantChecker={async () => {
                const data = await run(undefined, "/v1/memberships", {
                  actorId: checkerId,
                  role: "controller",
                });
                if (data) setCheckerGranted(true);
              }}
            />
          ) : null}

          {tab === "valuation" ? (
            <ValuationPanel
              disabled={busy}
              makerId={makers.valuation ?? session.actorId}
              checkerId={publishAs}
              run={valuationRun}
              version={valuationVersion}
              sensitivity={sensitivity}
              onRun={async (body) => {
                const data = await run(undefined, "/v1/valuations", body);
                const next = data ? decodeValuationRun(data) : null;
                if (next) {
                  setValuationRun(next);
                  setMakers((current) => ({ ...current, valuation: session.actorId }));
                  setValuationVersion({
                    id: next.valuationId,
                    status: field(data, "status") ?? "draft",
                    supersedesId: null,
                  });
                  setSensitivity(null);
                }
              }}
              onSensitivity={async () => {
                const currentId = valuationVersion?.id ?? valuationRun?.valuationId;
                if (!currentId) return;
                const data = await run(undefined, `/v1/valuations/${currentId}/calculate`, {
                  shocks: [{ id: "wacc-up", wacc: "0.12" }],
                });
                const next = data ? decodeSensitivity(data) : null;
                if (next) setSensitivity(next);
              }}
              onTransition={transitionValuation}
            />
          ) : null}

          {tab === "board" ? (
            <BoardPanel
              disabled={busy}
              publishedStateId={publishedStateId}
              publishedValuationId={publishedValuationId}
              pack={pack}
              onFreeze={async () => {
                const data = await run(undefined, "/v1/report-packs", {
                  statementStateId: publishedStateId,
                  valuationId: publishedValuationId,
                });
                const next = data ? decodeReportPack(data) : null;
                if (next) setPack(next);
                return next !== null;
              }}
            />
          ) : null}

          {tab === "group" ? (
            <GroupScreen
              disabled={busy}
              session={session}
              entities={entities.resource}
              entityId={entityId}
              run={run}
            />
          ) : null}
          {tab === "model" ? <ModelPanel disabled={busy} run={run} /> : null}
          {tab === "capital" ? (
            <CapitalPanel disabled={busy || entityId.length === 0} entityId={entityId} run={run} />
          ) : null}
          {tab === "import" ? <ImportPanel disabled={busy} run={run} /> : null}
          {tab === "assistant" ? (
            <AssistantPanel
              disabled={busy || entityId.length === 0 || periodId.length === 0}
              entityId={entityId}
              periodId={periodId}
              run={run}
            />
          ) : null}
          {tab === "deal" ? (
            <DealPanel disabled={busy} stateHash={stateVersion?.stateHash ?? ""} run={run} />
          ) : null}
          {tab === "basis" ? <BasisPanel disabled={busy} run={run} /> : null}
        </>
      )}
    </AppShell>
  );
}

interface Step {
  readonly tab: Tab;
  readonly label: string;
  readonly done: boolean;
  readonly detail: ReactNode;
}

function MainPathSteps({
  steps,
  current,
  onOpen,
}: {
  steps: readonly Step[];
  current: Tab;
  onOpen: (tab: Tab) => void;
}) {
  const firstOpen = steps.findIndex((step) => !step.done);
  return (
    <ol className="steps" aria-label="Main path">
      {steps.map((step, index) => {
        const tone = step.done
          ? "step step-done"
          : index === firstOpen
            ? "step step-current"
            : "step";
        return (
          <li
            key={step.label}
            className={tone}
            aria-current={index === firstOpen ? "step" : undefined}
          >
            <button
              type="button"
              onClick={() => onOpen(step.tab)}
              aria-label={`${step.label}: open ${TAB_LABELS[step.tab]}`}
            >
              <span className="step-top">
                <span className="step-index">{step.done ? "✓" : index + 1}</span>
                <span style={{ fontWeight: step.tab === current ? 680 : 620 }}>{step.label}</span>
              </span>
            </button>
            <span className="step-detail">{step.detail}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ProgramInspector({
  stateVersion,
  valuationRun,
  valuationVersion,
  pack,
  last,
}: {
  stateVersion: StateVersion | null;
  valuationRun: ValuationRun | null;
  valuationVersion: VersionRef | null;
  pack: ReportPack | null;
  last: LastResponse | null;
}) {
  const figures = last
    ? FIGURES.flatMap((key) => {
        const value = last.data[key];
        return typeof value === "string" ? [[key, value] as const] : [];
      })
    : [];
  const outputs = last?.data.outputs;
  const out =
    typeof outputs === "object" && outputs !== null && !Array.isArray(outputs)
      ? field(outputs as KernelRecord, "out")
      : null;
  const edges = last ? decodeLineage(last.data) : null;

  return (
    <>
      <InspectorSection
        title="Financial state"
        aside={stateVersion ? <StatusBadge status={stateVersion.status} /> : undefined}
      >
        {stateVersion ? (
          <dl className="kv kv-stack">
            <dt>State hash</dt>
            <dd>
              <code className="hash-wrap">{stateVersion.stateHash}</code>
            </dd>
            <dt>Engine version</dt>
            <dd>
              <code>{stateVersion.engineVersion ?? "—"}</code>
            </dd>
          </dl>
        ) : (
          <p className="inspector-note" style={{ marginTop: 0 }}>
            No state drafted in this session.
          </p>
        )}
      </InspectorSection>

      <InspectorSection
        title="Valuation"
        aside={
          valuationRun ? (
            <StatusBadge
              status={
                valuationRun.calculationStatus === "failed"
                  ? "failed"
                  : (valuationVersion?.status ?? "draft")
              }
            />
          ) : undefined
        }
      >
        {valuationRun ? (
          <dl className="kv kv-stack">
            {valuationRun.calculationStatus === "succeeded" ? (
              <>
                <dt>Enterprise value</dt>
                <dd className="figure">
                  {valuationRun.enterpriseValue ?? "—"} {valuationRun.currency ?? ""}
                </dd>
                <dt>Equity value</dt>
                <dd className="figure">
                  {valuationRun.equityValue ?? "—"} {valuationRun.currency ?? ""}
                </dd>
              </>
            ) : (
              <>
                <dt>Refusal</dt>
                <dd>
                  <code>{valuationRun.code ?? "—"}</code>
                </dd>
              </>
            )}
            <dt>Calculation run</dt>
            <dd>
              <code className="hash-wrap">{valuationRun.calculationRunId ?? "—"}</code>
            </dd>
            <dt>Input hash</dt>
            <dd>
              <code className="hash-wrap">{valuationRun.inputHash ?? "—"}</code>
            </dd>
            <dt>Engine version</dt>
            <dd>
              <code>{valuationRun.engineVersion ?? "—"}</code>
            </dd>
          </dl>
        ) : (
          <p className="inspector-note" style={{ marginTop: 0 }}>
            No valuation run in this session.
          </p>
        )}
      </InspectorSection>

      {pack ? (
        <InspectorSection title="Board pack" aside={<StatusBadge status={pack.status} />}>
          <dl className="kv kv-stack">
            <dt>Pack hash</dt>
            <dd>
              <code className="hash-wrap">{pack.stateHash}</code>
            </dd>
          </dl>
        </InspectorSection>
      ) : null}

      <InspectorSection title="Last kernel response">
        {last ? (
          <>
            <p className="inspector-note" style={{ marginTop: 0 }}>
              <code>
                {last.method} {last.path}
              </code>{" "}
              as {last.actorId}
            </p>
            {figures.length > 0 || out ? (
              <dl className="kv kv-stack" style={{ marginTop: "0.6rem" }}>
                {figures.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd className="hash-wrap">
                      {key === "status" || key === "calculationStatus" ? (
                        <StatusBadge status={value} />
                      ) : (
                        <code>{value}</code>
                      )}
                    </dd>
                  </div>
                ))}
                {out ? (
                  <div>
                    <dt>output</dt>
                    <dd>
                      <code>{out}</code>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {edges ? (
              edges.length === 0 ? (
                <p className="inspector-note">
                  No outgoing lineage edges for this object yet. Edges appear once a later version
                  or dependent object links from it.
                </p>
              ) : (
                <ul className="edge-list" style={{ marginTop: "0.6rem" }}>
                  {edges.map((edge, index) => (
                    <li key={`${edge.fromId}-${edge.toId}-${index}`}>
                      <strong>{edge.relation}</strong>
                      <div className="muted">
                        {edge.fromType} <code title={edge.fromId}>{edge.fromId.slice(0, 8)}…</code>{" "}
                        → {edge.toType} <code title={edge.toId}>{edge.toId.slice(0, 8)}…</code>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            <details style={{ marginTop: "0.6rem" }}>
              <summary className="small muted">Raw response</summary>
              <pre
                className="small"
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0.4rem 0 0" }}
              >
                {JSON.stringify(last.data, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <p className="inspector-note" style={{ marginTop: 0 }}>
            Kernel responses appear here, including hashes, run ids, and lineage edges.
          </p>
        )}
      </InspectorSection>

      <InspectorSection title="Kernel">
        <dl className="kv kv-stack">
          <dt>Engine version</dt>
          <dd>
            <EngineLine />
          </dd>
        </dl>
        <p className="inspector-note">
          <SuggestedBadge /> marks assistant proposals. Only kernel responses carry hashes and run
          ids.
        </p>
      </InspectorSection>
    </>
  );
}

function Setup({
  session,
  signed,
  onReady,
}: {
  session: Session;
  signed: SignedSession | null;
  onReady: (session: Session, entityId: string, periodId: string) => Promise<void>;
}) {
  const action = useAction();
  async function provision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const tenant = await action.run(() =>
      provisionTenant(session, { name, homeRegion: session.region }),
    );
    if (!tenant) return;
    const next = { ...session, tenantId: tenant.tenantId, region: tenant.homeRegion };
    if (signed) {
      const selected = await action.run(() => selectSessionTenant(tenant.tenantId));
      if (!selected) return;
    }
    const entity = await action.run(() =>
      createEntity(next, { legalName: `${name} Holdings`, functionalCurrency: "USD" }),
    );
    const createdEntityId = readId(entity, "entityId");
    if (!createdEntityId) return;
    const period = await action.run(() =>
      createPeriod(next, {
        entityId: createdEntityId,
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      }),
    );
    const createdPeriodId = readId(period, "periodId");
    if (!createdPeriodId) return;
    await createAccount(next, {
      entityId: createdEntityId,
      code: "1000",
      name: "Cash",
      report: "asset",
      cashFlow: "cash",
      retainedEarnings: false,
    });
    await onReady(next, createdEntityId, createdPeriodId);
  }
  if (signed && !signed.platformAdmin) {
    return (
      <section className="panel panel-narrow">
        <header className="page-head">
          <div>
            <h1>Open a company</h1>
            <p>
              You are signed in as <code>{session.actorId}</code> with no tenant selected. Paste a
              tenant ID you belong to in the session bar above. A platform administrator provisions
              new tenants.
            </p>
          </div>
        </header>
      </section>
    );
  }
  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>Open a company</h1>
          <p>
            The kernel provisions the tenant with <code>{session.actorId}</code> as owner, then a
            USD entity, a 2024 period, and a cash account.
          </p>
        </div>
      </header>
      <form className="form-card" onSubmit={(event) => void provision(event)}>
        <div className="form-row">
          <Field label="Company name">
            <Input name="name" required defaultValue="Program Co" />
          </Field>
          <Button type="submit" disabled={action.state.pending}>
            {action.state.pending ? "Provisioning…" : "Provision"}
          </Button>
        </div>
        {action.state.error ? (
          <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} />
        ) : null}
      </form>
    </section>
  );
}

function readId(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" ? id : null;
}
