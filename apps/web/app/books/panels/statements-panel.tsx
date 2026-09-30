"use client";

import { Button } from "@/components/ui/button";

import { getStatements, type Amount, type Entity, type Period, type Session } from "../api";
import { sessionKey, useResource } from "../hooks";
import { Figure, PanelHeader, ResourceView, StatusBadge } from "../ui";

interface StatementRow {
  readonly label: string;
  readonly value: Amount;
  readonly total?: boolean;
}

export function StatementsPanel({
  session,
  entity,
  period,
}: {
  session: Session;
  entity: Entity;
  period: Period;
}) {
  const statements = useResource(
    `${sessionKey(session)}|statements|${entity.entityId}|${period.periodId}`,
    () => getStatements(session, entity.entityId, period.periodId),
  );

  return (
    <section className="panel">
      <PanelHeader
        title="Financial statements"
        description={`Derived by the kernel from posted journals for ${period.startDate} to ${period.endDate}.`}
        action={
          <Button type="button" variant="outline" onClick={statements.reload}>
            Recalculate
          </Button>
        }
      />

      <ResourceView resource={statements.resource} label="statements">
        {(data) => (
          <>
            <dl className="lineage-strip" aria-label="Statement lineage">
              <div>
                <dt>Engine</dt>
                <dd>
                  <code>{data.engineVersion}</code>
                </dd>
              </div>
              <div>
                <dt>Input hash</dt>
                <dd>
                  <code className="hash-wrap" title={data.inputHash}>
                    {data.inputHash}
                  </code>
                </dd>
              </div>
              <div>
                <dt>RE close</dt>
                <dd>
                  <StatusBadge status={data.retainedEarnings.close} />
                  {data.retainedEarnings.close !== "derived" ? (
                    <span className="muted small"> Expected “derived”.</span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{data.currency}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>
                  {entity.legalName} ·{" "}
                  <span className="figure">
                    {period.startDate} → {period.endDate}
                  </span>{" "}
                  <StatusBadge status={period.status} />
                </dd>
              </div>
            </dl>
            <div className="statements-grid">
              <StatementTable
                title="Income statement"
                rows={[
                  { label: "Revenue", value: data.incomeStatement.revenue },
                  { label: "Expenses", value: data.incomeStatement.expenses },
                  { label: "Net income", value: data.incomeStatement.netIncome, total: true },
                ]}
              />
              <StatementTable
                title="Balance sheet"
                rows={[
                  { label: "Assets", value: data.balanceSheet.assets, total: true },
                  { label: "Liabilities", value: data.balanceSheet.liabilities },
                  { label: "Equity", value: data.balanceSheet.equity },
                ]}
              />
              <StatementTable
                title="Cash flow"
                rows={[
                  { label: "Beginning cash", value: data.cashFlow.beginningCash },
                  { label: "Operating (CFO)", value: data.cashFlow.cfo },
                  { label: "Investing (CFI)", value: data.cashFlow.cfi },
                  { label: "Financing (CFF)", value: data.cashFlow.cff },
                  { label: "Ending cash", value: data.cashFlow.endingCash, total: true },
                ]}
              />
              <StatementTable
                title="Retained earnings"
                rows={[
                  { label: "Opening", value: data.retainedEarnings.opening },
                  { label: "Net income", value: data.retainedEarnings.netIncome },
                  { label: "Distributions", value: data.retainedEarnings.distributions },
                  { label: "Ending", value: data.retainedEarnings.ending, total: true },
                ]}
              />
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Figures are displayed exactly as returned by the kernel. The same input hash and
              engine version always reproduce the same statements.
            </p>
          </>
        )}
      </ResourceView>
    </section>
  );
}

function StatementTable({ title, rows }: { title: string; rows: readonly StatementRow[] }) {
  return (
    <table className="grid statement">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th>Line</th>
          <th className="num">Amount</th>
          <th className="num">Minor units</th>
          <th>Currency</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className={row.total ? "row-total" : undefined}>
            <td>{row.label}</td>
            <td className="num">
              <Figure value={row.value.amount} />
            </td>
            <td className="num muted">
              <Figure value={row.value.minor} />
            </td>
            <td>{row.value.currency}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
