"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useState, type FormEvent } from "react";

import {
  CASH_FLOWS,
  REPORTS,
  createAccount,
  type Account,
  type CashFlow,
  type Entity,
  type Report,
  type Session,
} from "../api";
import { useAction, type Resource } from "../hooks";
import { ErrorNotice, Field, PanelHeader, ResourceView } from "../ui";

export function AccountsPanel({
  session,
  entity,
  accounts,
  onChanged,
}: {
  session: Session;
  entity: Entity;
  accounts: Resource<readonly Account[]>;
  onChanged: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [report, setReport] = useState<Report>("asset");
  const [cashFlow, setCashFlow] = useState<CashFlow>("cash");
  const [retainedEarnings, setRetainedEarnings] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim().length === 0 || name.trim().length === 0) {
      setFormError("Account code and name are required.");
      return;
    }
    setFormError(null);
    const created = await action.run(() =>
      createAccount(session, {
        entityId: entity.entityId,
        code: code.trim(),
        name: name.trim(),
        report,
        cashFlow,
        retainedEarnings,
      }),
    );
    if (created !== null) {
      setCode("");
      setName("");
      setRetainedEarnings(false);
      onChanged();
    }
  }

  return (
    <section className="panel">
      <PanelHeader
        title="Chart of accounts"
        description={`Accounts for ${entity.legalName}, denominated in ${entity.functionalCurrency}.`}
      />

      <ResourceView resource={accounts} label="accounts">
        {(rows) =>
          rows.length === 0 ? (
            <p className="empty">
              No accounts yet. Statements need at least a cash account and a retained earnings
              account.
            </p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Report</th>
                  <th>Cash flow</th>
                  <th>Currency</th>
                  <th>Status</th>
                  <th>Retained earnings</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((account) => (
                  <tr key={account.accountId}>
                    <td className="figure">{account.code}</td>
                    <td>{account.name}</td>
                    <td>{account.report}</td>
                    <td>{account.cashFlow}</td>
                    <td>{account.currency}</td>
                    <td>{account.active ? "Active" : <span className="muted">Inactive</span>}</td>
                    <td>{account.retainedEarnings ? "Yes" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>

      <form className="form-card" onSubmit={submit}>
        <h3>New account</h3>
        <div className="form-row">
          <Field label="Code">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={32}
              className="input-short"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
          </Field>
          <Field label="Report">
            <select value={report} onChange={(event) => setReport(parseReport(event.target.value))}>
              {REPORTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cash flow">
            <select
              value={cashFlow}
              onChange={(event) => setCashFlow(parseCashFlow(event.target.value))}
            >
              {CASH_FLOWS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <label className="checkbox">
            <Input
              type="checkbox"
              checked={retainedEarnings}
              onChange={(event) => setRetainedEarnings(event.target.checked)}
            />
            Retained earnings account
          </label>
          <Button type="submit" disabled={action.state.pending}>
            {action.state.pending ? "Creating…" : "Create account"}
          </Button>
        </div>
        {formError ? <p className="form-error">{formError}</p> : null}
        {action.state.error ? (
          <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} />
        ) : null}
      </form>
    </section>
  );
}

function parseReport(value: string): Report {
  return REPORTS.find((candidate) => candidate === value) ?? "asset";
}

function parseCashFlow(value: string): CashFlow {
  return CASH_FLOWS.find((candidate) => candidate === value) ?? "cash";
}
