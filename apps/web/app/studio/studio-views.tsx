"use client";

import type * as echarts from "echarts";
import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Chart } from "./charts";
import { csvCell, minorToAxis, minorToDisplay, percentFromRatio, shortHash, withCurrency } from "./format";
import { StatementGrid } from "./statement-grid";
import type { JournalView, PlatformView, Workspace } from "./types";

export function money(minor: string, currency: string): string {
  return withCurrency(minorToDisplay(minor), currency);
}

function colors(dark: boolean) {
  return {
    text: dark ? "#d7dee8" : "#14213a",
    muted: dark ? "#93a0b0" : "#5b6878",
    split: dark ? "#2c3542" : "#e0e5ec",
    revenue: "#2f6fad",
    cash: "#1a8f86",
    plan: "#8a5a00",
    alert: "#b3261e",
  };
}

function baseOption(dark: boolean): echarts.EChartsOption {
  const tone = colors(dark);
  return {
    textStyle: { fontFamily: "inherit", color: tone.text },
    grid: { left: 48, right: 16, top: 28, bottom: 28 },
    tooltip: { trigger: "axis" },
    legend: { textStyle: { color: tone.muted }, top: 0 },
    xAxis: { type: "category", axisLabel: { color: tone.muted }, axisLine: { lineStyle: { color: tone.split } } },
    yAxis: { type: "value", axisLabel: { color: tone.muted }, splitLine: { lineStyle: { color: tone.split } } },
  };
}

export function DashboardView({ workspace, periodIndex, dark }: { readonly workspace: Workspace; readonly periodIndex: number; readonly dark: boolean }) {
  const currency = workspace.context.currency;
  const period = workspace.statements.periods[periodIndex];
  const tone = colors(dark);
  const option = useMemo<echarts.EChartsOption>(() => {
    const labels = workspace.series.map((point) => point.label);
    return {
      ...baseOption(dark),
      xAxis: { ...(baseOption(dark).xAxis as object), data: labels },
      series: [
        { name: "Revenue", type: "line", smooth: true, showSymbol: false, data: workspace.series.map((point) => minorToAxis(point.revenue)), color: tone.revenue },
        { name: "Ending cash", type: "line", smooth: true, showSymbol: false, data: workspace.series.map((point) => minorToAxis(point.cash)), color: tone.cash },
      ],
    };
  }, [dark, tone.cash, tone.revenue, workspace.series]);
  const revenue = cell(workspace, "revenue", periodIndex);
  const net = cell(workspace, "net", periodIndex);
  const cash = cell(workspace, "end", periodIndex);
  const equityGap = BigInt(cellMinor(workspace, "assets", periodIndex)) - BigInt(cellMinor(workspace, "liabilities", periodIndex)) - BigInt(cellMinor(workspace, "equity", periodIndex));
  return (
    <div className="nx-stack" data-testid="screen-dashboard">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Board-ready close</p>
          <h1>{workspace.context.entityName}</h1>
          <p className="nx-lede">Kernel figures for {period?.label ?? workspace.context.periodLabel}. Supervised autonomy proposes; posted books stay posted.</p>
        </div>
        <span className={`nx-pill ${equityGap === 0n ? "is-good" : "is-bad"}`}>{equityGap === 0n ? "Assets = liabilities + equity" : "Balance sheet out of identity"}</span>
      </header>
      <div className="nx-kpis">
        <KpiCard label="Revenue" display={withCurrency(revenue, currency)} hash={period?.inputHash ?? ""} engine={period?.engineVersion ?? workspace.engineVersion} />
        <KpiCard label="Net income" display={withCurrency(net, currency)} hash={period?.inputHash ?? ""} engine={period?.engineVersion ?? workspace.engineVersion} />
        <KpiCard label="Ending cash" display={withCurrency(cash, currency)} hash={period?.inputHash ?? ""} engine={period?.engineVersion ?? workspace.engineVersion} />
        {workspace.kpis.filter((item) => item.id === "normalized").map((item) => (
          <KpiCard key={item.id} label={item.label} display={withCurrency(item.display, currency)} hash={item.lineage.inputHash} engine={item.lineage.engineVersion} />
        ))}
      </div>
      <section className="nx-panel">
        <h2>Revenue and cash</h2>
        <Chart option={option} label="Revenue and ending cash by month" />
      </section>
      <div className="nx-split">
        <section className="nx-panel">
          <h2>Variance versus plan</h2>
          <ul className="nx-list">
            {workspace.variance.lines.map((line) => (
              <li key={line.key}>
                <span>{line.label}</span>
                <strong className={line.favorable ? "is-good" : "is-bad"}>{money(line.varianceMinor, currency)}</strong>
              </li>
            ))}
          </ul>
        </section>
        <section className="nx-panel">
          <h2>Waiting on you</h2>
          <p className="nx-muted">{workspace.approvals.filter((item) => item.status === "suggested").length} suggested proposals. Agents do not post.</p>
        </section>
      </div>
    </div>
  );
}

function cell(workspace: Workspace, key: string, index: number): string {
  return workspace.statements.rows.find((row) => row.key === key)?.values[index]?.display ?? "0.00";
}

function cellMinor(workspace: Workspace, key: string, index: number): string {
  return workspace.statements.rows.find((row) => row.key === key)?.values[index]?.minor ?? "0";
}

function KpiCard({ label, display, hash, engine }: { readonly label: string; readonly display: string; readonly hash: string; readonly engine: string }) {
  return (
    <article className="nx-kpi">
      <p>{label}</p>
      <strong>{display}</strong>
      <small title={hash}>{engine} · {shortHash(hash)}</small>
    </article>
  );
}

export function OnboardingView({ workspace }: { readonly workspace: Workspace }) {
  const certificate = workspace.onboarding.certificate;
  return (
    <div className="nx-stack" data-testid="screen-onboarding">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Onboarding</p>
          <h1>Trial balance, statements, then a certificate</h1>
          <p className="nx-lede">The demo books are a balanced reconstruction of Nazareno Services. Workbook totals are evidence, not silent journal imports.</p>
        </div>
      </header>
      <ol className="nx-steps">
        {workspace.onboarding.steps.map((step, index) => (
          <li key={step.id} className={step.state === "complete" ? "is-good" : ""}>
            <span>{index + 1}</span>
            <div>
              <strong>{step.label}</strong>
              <p>{step.state}</p>
            </div>
          </li>
        ))}
      </ol>
      <section className="nx-panel" data-testid="reconciliation">
        <h2>Reconciliation certificate</h2>
        <dl className="nx-facts">
          <div><dt>Book cash</dt><dd>{withCurrency(certificate.bookCash.display, workspace.context.currency)}</dd></div>
          <div><dt>Staged bank figure</dt><dd>{withCurrency(certificate.bankCash.display, workspace.context.currency)}</dd></div>
          <div><dt>Difference</dt><dd>{withCurrency(certificate.difference.display, workspace.context.currency)}</dd></div>
          <div><dt>Status</dt><dd>{certificate.status}</dd></div>
          <div><dt>Source</dt><dd>{certificate.sourceDocument}</dd></div>
          <div><dt>Lineage</dt><dd title={certificate.inputHash}>{certificate.engineVersion} · {shortHash(certificate.inputHash)}</dd></div>
        </dl>
        <p className="nx-muted">The certificate difference is a kernel subtraction. The bank PDFs are staged; their printed totals are not parsed into a second cash number in this build.</p>
      </section>
    </div>
  );
}

export function StatementsView({
  workspace,
  periodIndex,
  onSelectPeriod,
}: {
  readonly workspace: Workspace;
  readonly periodIndex: number;
  readonly onSelectPeriod: (periodId: string) => void;
}) {
  const period = workspace.statements.periods[periodIndex];
  const journals = workspace.journals.filter((journal) => journal.periodId === period?.periodId);
  function exportCsv() {
    const header = ["Line", "Section", ...workspace.statements.periods.map((item) => item.label)];
    const body = workspace.statements.rows.map((row) => [row.label, row.section, ...row.values.map((value) => value.display)]);
    const csv = [header, ...body].map((line) => line.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nazareno-statements.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="nx-stack" data-testid="screen-statements">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Three statements</p>
          <h1>Monthly actuals</h1>
          <p className="nx-lede">Each month is a kernel statement. Prior earnings sit in retained earnings, not in this month&apos;s revenue.</p>
        </div>
        <Button type="button" variant="outline" onClick={exportCsv} data-testid="export-csv">Export CSV</Button>
      </header>
      <StatementGrid periods={workspace.statements.periods} rows={workspace.statements.rows} selectedPeriodId={period?.periodId ?? ""} onSelectPeriod={onSelectPeriod} />
      <section className="nx-panel">
        <h2>Journals for {period?.label}</h2>
        <p className="nx-muted">Posted journals are immutable. Hash {period ? shortHash(period.inputHash) : "—"} · {period?.engineVersion}</p>
        {journals.length === 0 ? <p className="nx-empty">No posted journals in this period.</p> : <JournalList journals={journals} />}
      </section>
    </div>
  );
}

function JournalList({ journals }: { readonly journals: readonly JournalView[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = journals.flatMap((journal) => journal.lines.map((line, index) => ({
    id: `${journal.journalId}-${index}`,
    source: journal.sourceRef,
    hash: journal.payloadHash,
    account: line.account,
    debit: line.debit.display,
    credit: line.credit.display,
  })));
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 34,
    overscan: 6,
    getItemKey: (index) => lines[index]?.id ?? String(index),
  });
  return (
    <div className="nx-journal" ref={ref} data-testid="journal-drill">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const line = lines[item.index];
          if (!line) return null;
          return (
            <div key={line.id} className="nx-journal-row" style={{ transform: `translateY(${item.start}px)` }} title={line.hash}>
              <span>{line.source}</span>
              <span>{line.account}</span>
              <span>{line.debit}</span>
              <span>{line.credit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ForecastView({
  workspace,
  dark,
  onSave,
  busy,
}: {
  readonly workspace: Workspace;
  readonly dark: boolean;
  readonly busy: boolean;
  readonly onSave: (input: { revenueMinor: string; growthRate: string; grossMargin: string; opexMinor: string; scenarioGrowthRate: string }) => void;
}) {
  const drivers = workspace.forecast.drivers;
  const [revenueMinor, setRevenue] = useState(drivers.revenueMinor);
  const [growthRate, setGrowth] = useState(drivers.growthRate);
  const [grossMargin, setMargin] = useState(drivers.grossMargin);
  const [opexMinor, setOpex] = useState(drivers.opexMinor);
  const [scenarioGrowthRate, setScenario] = useState(workspace.forecast.scenarioGrowthRate);
  const currency = workspace.context.currency;
  const tone = colors(dark);
  const option = useMemo<echarts.EChartsOption>(() => ({
    ...baseOption(dark),
    xAxis: { ...(baseOption(dark).xAxis as object), data: workspace.forecast.base.months.map((month) => `M${month.period}`) },
    series: [
      { name: "Base revenue", type: "line", data: workspace.forecast.base.months.map((month) => minorToAxis(month.revenueMinor)), color: tone.revenue },
      { name: "Scenario revenue", type: "line", data: workspace.forecast.scenario.months.map((month) => minorToAxis(month.revenueMinor)), color: tone.plan },
    ],
  }), [dark, tone.plan, tone.revenue, workspace.forecast.base.months, workspace.forecast.scenario.months]);
  return (
    <div className="nx-stack" data-testid="screen-forecast">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Driver forecast</p>
          <h1>Twelve months, two cases</h1>
          <p className="nx-lede">Period 1 is the opening run-rate. Later months compound growth inside the kernel. Hash {shortHash(workspace.forecast.base.inputHash)}.</p>
        </div>
      </header>
      <form
        className="nx-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ revenueMinor, growthRate, grossMargin, opexMinor, scenarioGrowthRate });
        }}
      >
        <label>Run-rate revenue (minor)<Input value={revenueMinor} onChange={(event) => setRevenue(event.target.value)} data-testid="driver-revenue" /></label>
        <label>Growth rate<Input value={growthRate} onChange={(event) => setGrowth(event.target.value)} /></label>
        <label>Gross margin<Input value={grossMargin} onChange={(event) => setMargin(event.target.value)} /></label>
        <label>Opex (minor)<Input value={opexMinor} onChange={(event) => setOpex(event.target.value)} /></label>
        <label>Scenario growth<Input value={scenarioGrowthRate} onChange={(event) => setScenario(event.target.value)} /></label>
        <Button type="submit" disabled={!workspace.permissions.canWrite || busy}>{busy ? "Saving" : "Recompute"}</Button>
      </form>
      {!workspace.permissions.canWrite ? <p className="nx-muted">Viewers can read the forecast. They cannot change drivers.</p> : null}
      <section className="nx-panel">
        <Chart option={option} label="Base and scenario revenue" />
      </section>
      <div className="nx-table-wrap">
        <table className="nx-table">
          <thead>
            <tr><th>Month</th><th>Base revenue</th><th>Base EBITDA</th><th>Scenario revenue</th><th>Scenario EBITDA</th></tr>
          </thead>
          <tbody>
            {workspace.forecast.base.months.map((month, index) => {
              const scenario = workspace.forecast.scenario.months[index];
              return (
                <tr key={month.period}>
                  <td>M{month.period}</td>
                  <td>{money(month.revenueMinor, currency)}</td>
                  <td>{money(month.ebitdaMinor, currency)}</td>
                  <td>{scenario ? money(scenario.revenueMinor, currency) : "—"}</td>
                  <td>{scenario ? money(scenario.ebitdaMinor, currency) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CashView({ workspace, scenario, dark }: { readonly workspace: Workspace; readonly scenario: "base" | "downside"; readonly dark: boolean }) {
  const cash = scenario === "base" ? workspace.cash.base : workspace.cash.downside;
  const currency = workspace.context.currency;
  const tone = colors(dark);
  const option = useMemo<echarts.EChartsOption>(() => ({
    ...baseOption(dark),
    xAxis: { ...(baseOption(dark).xAxis as object), data: cash.weeks.map((week) => week.label.slice(5)) },
    series: [
      {
        name: "Ending cash",
        type: "bar",
        data: cash.weeks.map((week) => ({ value: minorToAxis(week.endingMinor), itemStyle: { color: week.belowMinimum ? tone.alert : tone.cash } })),
      },
    ],
  }), [cash.weeks, dark, tone.alert, tone.cash]);
  return (
    <div className="nx-stack" data-testid="screen-cash">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">13-week cash</p>
          <h1>{scenario === "base" ? "Base case" : "Downside case"}</h1>
          <p className="nx-lede">Opening cash is the kernel ending balance. Minimum cash is {money(cash.minimumCashMinor, currency)}. Hash {shortHash(cash.inputHash)}.</p>
        </div>
        <span className={`nx-pill ${cash.alerts.length === 0 ? "is-good" : "is-bad"}`}>{cash.alerts.length} weeks below minimum</span>
      </header>
      <section className="nx-panel"><Chart option={option} label="Thirteen week ending cash" /></section>
      <div className="nx-table-wrap">
        <table className="nx-table">
          <thead>
            <tr><th>Week</th><th>Beginning</th><th>In</th><th>Out</th><th>Ending</th><th>Headroom</th></tr>
          </thead>
          <tbody>
            {cash.weeks.map((week) => (
              <tr key={week.weekIndex} className={week.belowMinimum ? "is-alert" : ""}>
                <td>{week.label}</td>
                <td>{money(week.beginningMinor, currency)}</td>
                <td>{money(week.inflowMinor, currency)}</td>
                <td>{money(week.outflowMinor, currency)}</td>
                <td>{money(week.endingMinor, currency)}</td>
                <td>{money(week.headroomMinor, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function VarianceView({ workspace, dark }: { readonly workspace: Workspace; readonly dark: boolean }) {
  const currency = workspace.context.currency;
  const tone = colors(dark);
  const option = useMemo<echarts.EChartsOption>(() => ({
    ...baseOption(dark),
    xAxis: { ...(baseOption(dark).xAxis as object), data: workspace.variance.lines.map((line) => line.label) },
    series: [
      { name: "Actual", type: "bar", data: workspace.variance.lines.map((line) => minorToAxis(line.actualMinor)), color: tone.revenue },
      { name: "Plan", type: "bar", data: workspace.variance.lines.map((line) => minorToAxis(line.planMinor)), color: tone.plan },
    ],
  }), [dark, tone.plan, tone.revenue, workspace.variance.lines]);
  return (
    <div className="nx-stack" data-testid="screen-variance">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Variance</p>
          <h1>Actual minus plan</h1>
          <p className="nx-lede">Favorable means higher revenue or profit, or lower expense. Hash {shortHash(workspace.variance.inputHash)}.</p>
        </div>
      </header>
      <section className="nx-panel"><Chart option={option} label="Actual versus plan" /></section>
      <div className="nx-table-wrap">
        <table className="nx-table">
          <thead><tr><th>Line</th><th>Actual</th><th>Plan</th><th>Variance</th><th>Ratio</th><th></th></tr></thead>
          <tbody>
            {workspace.variance.lines.map((line) => (
              <tr key={line.key}>
                <td>{line.label}</td>
                <td>{money(line.actualMinor, currency)}</td>
                <td>{money(line.planMinor, currency)}</td>
                <td>{money(line.varianceMinor, currency)}</td>
                <td>{percentFromRatio(line.varianceRatio)}</td>
                <td className={line.favorable ? "is-good" : "is-bad"}>{line.favorable ? "Favorable" : "Unfavorable"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function QoeView({ workspace, dark }: { readonly workspace: Workspace; readonly dark: boolean }) {
  const currency = workspace.context.currency;
  const tone = colors(dark);
  const option = useMemo<echarts.EChartsOption>(() => {
    const labels = ["Reported", ...workspace.qoe.steps.map((step) => step.label), "Normalized"];
    const values = [workspace.qoe.reported, ...workspace.qoe.steps.map((step) => step.amount), workspace.qoe.normalized];
    return {
      ...baseOption(dark),
      xAxis: { ...(baseOption(dark).xAxis as object), data: labels },
      series: [{ name: "Bridge", type: "bar", data: values.map((value) => minorToAxis(value)), color: tone.revenue }],
    };
  }, [dark, tone.revenue, workspace.qoe]);
  return (
    <div className="nx-stack" data-testid="screen-qoe">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Quality of earnings</p>
          <h1>Reported net income, then accepted add-backs</h1>
          <p className="nx-lede">The bridge starts from kernel net income. These books have no depreciation line, so the result is normalized earnings, not a full EBITDA build. Hash {shortHash(workspace.qoe.inputHash)}.</p>
        </div>
      </header>
      <section className="nx-panel"><Chart option={option} label="Quality of earnings bridge" /></section>
      <ol className="nx-bridge">
        <li><span>Reported</span><strong>{money(workspace.qoe.reported, currency)}</strong></li>
        {workspace.qoe.steps.map((step) => (
          <li key={step.adjustmentId}><span>{step.label}</span><strong>+ {money(step.amount, currency)}</strong><small title={step.stepHash}>{shortHash(step.stepHash)}</small></li>
        ))}
        <li><span>Normalized</span><strong>{money(workspace.qoe.normalized, currency)}</strong></li>
      </ol>
    </div>
  );
}

export function BoardView({ workspace }: { readonly workspace: Workspace }) {
  return (
    <div className="nx-stack" data-testid="screen-board">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Board pack</p>
          <h1>{workspace.board.title}</h1>
          <p className="nx-lede">Cutoff {workspace.board.cutoff}. Every figure opens to a kernel hash. State {shortHash(workspace.board.stateHash)}.</p>
        </div>
      </header>
      {workspace.board.sections.map((section) => (
        <section key={section.heading} className="nx-panel">
          <h2>{section.heading}</h2>
          <div className="nx-figures">
            {section.figures.map((figure) => (
              <article key={figure.label}>
                <p>{figure.label}</p>
                <strong>{withCurrency(figure.display, workspace.context.currency)}</strong>
                <small title={figure.inputHash}>{shortHash(figure.inputHash)}</small>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ApprovalsView({
  workspace,
  busyId,
  onDecide,
}: {
  readonly workspace: Workspace;
  readonly busyId: string | null;
  readonly onDecide: (id: string, decision: "accepted" | "rejected") => void;
}) {
  const waiting = workspace.approvals.filter((item) => item.status === "suggested");
  return (
    <div className="nx-stack" data-testid="screen-approvals">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Approvals inbox</p>
          <h1>Suggested, until someone accepts</h1>
          <p className="nx-lede">Accepting records a decision. It does not post a journal or change actuals.</p>
        </div>
      </header>
      {workspace.approvals.length === 0 ? <p className="nx-empty">No proposals yet. Ask a specialist in the copilot.</p> : null}
      <ul className="nx-cards">
        {workspace.approvals.map((item) => (
          <li key={item.id} className="nx-card" data-testid={`proposal-${item.status}`}>
            <div>
              <p className="nx-kicker">{item.agent} · {item.status}</p>
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              <small title={item.citationId}>Citation {shortHash(item.citationId)}</small>
            </div>
            {item.status === "suggested" ? (
              <div className="nx-row">
                <Button type="button" disabled={!workspace.permissions.canWrite || busyId === item.id} onClick={() => onDecide(item.id, "accepted")} data-testid="accept-proposal">Accept</Button>
                <Button type="button" variant="outline" disabled={!workspace.permissions.canWrite || busyId === item.id} onClick={() => onDecide(item.id, "rejected")}>Reject</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {waiting.length === 0 && workspace.approvals.length > 0 ? <p className="nx-muted">Nothing is waiting. Earlier decisions stay on the record.</p> : null}
    </div>
  );
}

export function AdminView({
  workspace,
  busy,
  onInvite,
}: {
  readonly workspace: Workspace;
  readonly busy: boolean;
  readonly onInvite: (actorId: string, role: string) => void;
}) {
  const [actorId, setActorId] = useState("");
  const [role, setRole] = useState("viewer");
  return (
    <div className="nx-stack" data-testid="screen-admin">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Organization</p>
          <h1>{workspace.context.tenantName}</h1>
          <p className="nx-lede">Roles come from membership. The AI policy is a record, not a bypass of the kernel.</p>
        </div>
      </header>
      <section className="nx-panel">
        <h2>Members</h2>
        <ul className="nx-list">
          {workspace.admin.members.map((member) => (
            <li key={member.actorId}><span>{member.actorId}</span><strong>{member.role}</strong></li>
          ))}
        </ul>
        <form
          className="nx-form"
          onSubmit={(event) => {
            event.preventDefault();
            onInvite(actorId, role);
          }}
        >
          <label>Actor id<Input value={actorId} onChange={(event) => setActorId(event.target.value)} data-testid="member-actor" /></label>
          <label>Role
            <select value={role} onChange={(event) => setRole(event.target.value)} data-testid="member-role">
              <option value="owner">owner</option>
              <option value="controller">controller</option>
              <option value="viewer">viewer</option>
              <option value="auditor">auditor</option>
            </select>
          </label>
          <Button type="submit" disabled={!workspace.permissions.canWrite || actorId.trim().length === 0 || busy}>Grant role</Button>
        </form>
      </section>
      <section className="nx-panel">
        <h2>Policies</h2>
        {workspace.admin.policies.map((policy) => (
          <article key={policy.id}><h3>{policy.name}</h3><p>{policy.body}</p></article>
        ))}
      </section>
      <section className="nx-panel">
        <h2>Audit</h2>
        {workspace.admin.auditLocked ? <p className="nx-empty">Audit is locked for this role.</p> : (
          <ul className="nx-audit">
            {workspace.admin.audit.slice(0, 12).map((event) => (
              <li key={event.eventId}><span>{event.occurredAt.slice(0, 16).replace("T", " ")}</span><strong>{event.eventType}</strong><em>{event.actorId}</em></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function PlatformViewScreen({
  platform,
  busy,
  onStatus,
  onFlag,
  onSupport,
}: {
  readonly platform: PlatformView | null;
  readonly busy: boolean;
  readonly onStatus: (tenantId: string, status: "active" | "suspended") => void;
  readonly onFlag: (id: string, enabled: boolean) => void;
  readonly onSupport: (tenantId: string, hours: number, reason: string) => void;
}) {
  const [hours, setHours] = useState("4");
  const [reason, setReason] = useState("Close support for the September board pack");
  if (!platform) return <p className="nx-empty" data-testid="screen-platform">Platform console is loading.</p>;
  const tenant = platform.tenants[0];
  return (
    <div className="nx-stack" data-testid="screen-platform">
      <header className="nx-page-head">
        <div>
          <p className="nx-kicker">Platform</p>
          <h1>Tenants, access, and AI ops</h1>
          <p className="nx-lede">Platform admin has no standing right to the books. Support access is an auditor membership with an expiry.</p>
        </div>
      </header>
      <section className="nx-panel">
        <h2>Tenants</h2>
        <ul className="nx-list">
          {platform.tenants.map((item) => (
            <li key={item.tenantId}>
              <span>{item.name} · {item.region}</span>
              <strong>{item.status}</strong>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onStatus(item.tenantId, item.status === "active" ? "suspended" : "active")}>
                {item.status === "active" ? "Suspend" : "Reactivate"}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section className="nx-panel">
        <h2>Feature flags</h2>
        <ul className="nx-list">
          {platform.flags.map((flag) => (
            <li key={flag.id}>
              <span>{flag.label}</span>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onFlag(flag.id, !flag.enabled)} data-testid={`flag-${flag.key}`}>{flag.enabled ? "On" : "Off"}</Button>
            </li>
          ))}
        </ul>
      </section>
      <section className="nx-panel">
        <h2>Connectors</h2>
        <ul className="nx-list">
          {platform.connectors.map((connector) => (
            <li key={connector.id}><span>{connector.label}</span><strong>{connector.status}</strong><em>{connector.detail}</em></li>
          ))}
        </ul>
      </section>
      <section className="nx-panel">
        <h2>Time-boxed support</h2>
        {tenant ? (
          <form
            className="nx-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSupport(tenant.tenantId, Number(hours), reason);
            }}
          >
            <label>Hours<Input value={hours} onChange={(event) => setHours(event.target.value)} /></label>
            <label>Reason<Input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <Button type="submit" disabled={busy}>Grant auditor access</Button>
          </form>
        ) : <p className="nx-empty">No tenant is registered in this process.</p>}
        <ul className="nx-audit">
          {platform.support.map((grant) => (
            <li key={grant.id}><span>{grant.status}</span><strong>{grant.actorId}</strong><em>{grant.expiresAt}</em></li>
          ))}
        </ul>
      </section>
      <section className="nx-panel">
        <h2>AI runs</h2>
        {platform.runs.length === 0 ? <p className="nx-empty">No copilot runs yet. A mock or live answer will show up here.</p> : (
          <ul className="nx-audit">
            {platform.runs.map((run) => (
              <li key={run.id}><span>{run.mode}</span><strong>{run.agent}</strong><em>{run.status}</em></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
