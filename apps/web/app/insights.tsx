"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  getStatements,
  listEntities,
  listPeriods,
  type Amount,
  type Entity,
  type Period,
  type Session,
  type Statements,
} from "./books/api";
import { Figure, MetricTile } from "./books/ui";

interface KernelHealth {
  readonly status: string;
  readonly service: string;
  readonly engineVersion: string;
}

type Load =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "empty"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly entity: Entity;
      readonly period: Period;
      readonly statements: Statements;
    };

function latestPeriod(periods: readonly Period[]): Period | null {
  const ordered = [...periods].sort((left, right) => right.endDate.localeCompare(left.endDate));
  return ordered[0] ?? null;
}

function money(amount: Amount): string {
  return amount.amount;
}

export function Insights({ session, health }: { session: Session; health: KernelHealth | null }) {
  const [load, setLoad] = useState<Load>({ status: "idle" });

  const tenantId = session.tenantId;
  const actorId = session.actorId;
  const region = session.region;

  useEffect(() => {
    if (tenantId.length === 0) {
      setLoad({
        status: "empty",
        message: "Sign in and open a company before Insights can show actuals.",
      });
      return;
    }
    const current: Session = { actorId, tenantId, region };
    let cancelled = false;
    setLoad({ status: "loading" });
    void (async () => {
      const entities = await listEntities(current);
      if (cancelled) return;
      if (!entities.ok) {
        setLoad({ status: "error", message: entities.error.message });
        return;
      }
      const entity = entities.data[0];
      if (!entity) {
        setLoad({
          status: "empty",
          message: "No company is on the books yet. Create one in the ledger, then post a journal.",
        });
        return;
      }
      const periods = await listPeriods(current, entity.entityId);
      if (cancelled) return;
      if (!periods.ok) {
        setLoad({ status: "error", message: periods.error.message });
        return;
      }
      const period = latestPeriod(periods.data);
      if (!period) {
        setLoad({
          status: "empty",
          message: `${entity.legalName} has no period. Open an accounting period, then post activity.`,
        });
        return;
      }
      const statements = await getStatements(current, entity.entityId, period.periodId);
      if (cancelled) return;
      if (!statements.ok) {
        setLoad({ status: "error", message: statements.error.message });
        return;
      }
      setLoad({ status: "ready", entity, period, statements: statements.data });
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId, tenantId, region]);

  const ready = load.status === "ready" ? load : null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Insights</h1>
          <p>
            Actuals for the latest period, derived by the kernel from posted journals. Projections,
            valuation, and the board pack stay on their own pages and use the same engine.
          </p>
        </div>
        <Link href="/books?tab=statements" className="button-ghost">
          Open actuals
        </Link>
      </header>

      <div className="metrics">
        <MetricTile
          label="Net income"
          value={ready ? money(ready.statements.incomeStatement.netIncome) : null}
          unit={ready ? ready.statements.currency : undefined}
          basis={
            ready
              ? `${ready.entity.legalName} · ${ready.period.startDate} to ${ready.period.endDate}`
              : load.status === "loading"
                ? "Reading the ledger"
                : "Waiting for posted activity"
          }
        />
        <MetricTile
          label="Assets"
          value={ready ? money(ready.statements.balanceSheet.assets) : null}
          unit={ready ? ready.statements.currency : undefined}
          basis={
            ready
              ? `Liabilities ${ready.statements.balanceSheet.liabilities.amount} · Equity ${ready.statements.balanceSheet.equity.amount}`
              : "Balance sheet from the kernel"
          }
        />
        <MetricTile
          label="Ending cash"
          value={ready ? money(ready.statements.cashFlow.endingCash) : null}
          unit={ready ? ready.statements.currency : undefined}
          basis={
            ready
              ? `Begin ${ready.statements.cashFlow.beginningCash.amount} · CFO ${ready.statements.cashFlow.cfo.amount} · CFI ${ready.statements.cashFlow.cfi.amount} · CFF ${ready.statements.cashFlow.cff.amount}`
              : "Cash flow is calculated from classified activity"
          }
        />
        <MetricTile
          label="Engine"
          value={ready ? ready.statements.engineVersion : health ? health.engineVersion : null}
          small
          status={
            health ? (
              <span className="badge badge-green">Online</span>
            ) : (
              <span className="badge badge-red">Unreachable</span>
            )
          }
          basis={
            ready ? (
              <code className="hash-wrap">{ready.statements.inputHash}</code>
            ) : health ? (
              health.service
            ) : (
              "Start the API"
            )
          }
        />
      </div>

      {load.status === "empty" || load.status === "error" ? (
        <p className={load.status === "error" ? "form-error" : "muted"}>{load.message}</p>
      ) : null}

      {ready ? (
        <dl className="lineage-strip" aria-label="Actuals lineage">
          <div>
            <dt>Company</dt>
            <dd>{ready.entity.legalName}</dd>
          </div>
          <div>
            <dt>Period</dt>
            <dd className="figure">
              {ready.period.startDate} → {ready.period.endDate}
            </dd>
          </div>
          <div>
            <dt>Retained earnings</dt>
            <dd>
              <Figure value={ready.statements.retainedEarnings.ending.amount} />{" "}
              {ready.statements.currency} · {ready.statements.retainedEarnings.close}
            </dd>
          </div>
          <div>
            <dt>Input hash</dt>
            <dd>
              <code className="hash-wrap">{ready.statements.inputHash}</code>
            </dd>
          </div>
        </dl>
      ) : null}
    </>
  );
}
