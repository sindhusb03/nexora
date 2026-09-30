"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useState, type FormEvent } from "react";

import type { Session } from "./books/api";
import { useAction } from "./books/hooks";
import { ErrorNotice, Field, SuggestedBadge } from "./books/ui";
import { smartLedgerApplies, writeDataSource, type DataSourceState } from "./data-source";
import { kernelCall } from "./program/api";

const CATEGORIES = [
  "Cash",
  "Accounts receivable",
  "Inventory",
  "Fixed assets",
  "Accounts payable",
  "Debt",
  "Equity",
  "Revenue",
  "Operating expense",
  "Payroll",
] as const;

export function SmartLedger({
  session,
  source,
  onChange,
}: {
  session: Session;
  source: DataSourceState;
  onChange: (next: DataSourceState) => void;
}) {
  const action = useAction();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  if (!smartLedgerApplies(source.kind)) {
    return (
      <section className="panel panel-narrow">
        <h1>Smart Ledger</h1>
        <div className="notice notice-locked" role="status">
          <strong>Smart Ledger not applicable.</strong>
          <p>
            Choose Bank or Trial balance in Upload and Map. Financial statements stay structured.
          </p>
        </div>
      </section>
    );
  }

  function setCategory(rowNo: number, category: string) {
    const next = {
      ...source,
      rows: source.rows.map((row) => (row.rowNo === rowNo ? { ...row, category } : row)),
    };
    writeDataSource(next);
    onChange(next);
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (text.length === 0) return;
    const data = await action.run(() =>
      kernelCall(session, "POST", "/v1/proposals", {
        claims: [{ text, citationId: null }],
      }),
    );
    if (!data) {
      setAnswer(null);
      return;
    }
    const refusal = typeof data.refusal === "string" ? data.refusal : null;
    setAnswer(
      refusal ??
        "The kernel accepted the wording. A number still needs a citation before it can be shown as a figure.",
    );
  }

  const dated = source.rows.some((row) => typeof row.date === "string");
  const duplicateAccounts = new Set<string>();
  const seen = new Set<string>();
  for (const row of source.rows) {
    if (typeof row.date === "string") continue;
    const key = row.account.toLowerCase();
    if (seen.has(key)) duplicateAccounts.add(key);
    seen.add(key);
  }

  return (
    <section className="panel">
      <header className="page-head">
        <div>
          <h1>
            Smart Ledger <SuggestedBadge />
          </h1>
          <p>
            Re-map any category. Suggestions stay labeled until you change them. This screen does
            not post journals.
          </p>
        </div>
      </header>
      <div className="notice notice-info" role="status">
        <strong>Smart Ledger enabled.</strong>
        <p>You can re-map any category. Anomaly scores appear when a kernel run returns one.</p>
      </div>
      {source.rows.length === 0 ? (
        <p className="muted">Upload a bank or trial-balance file to list rows here.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Row</th>
              {dated ? <th>Date</th> : null}
              <th>{dated ? "Description" : "Account"}</th>
              <th>Amount</th>
              <th>Category</th>
              <th>Row check</th>
            </tr>
          </thead>
          <tbody>
            {source.rows.map((row) => {
              const suggested =
                row.suggestedCategory !== null && row.category === row.suggestedCategory;
              const duplicate = duplicateAccounts.has(row.account.toLowerCase());
              return (
                <tr key={row.rowNo}>
                  <td className="num">{row.rowNo}</td>
                  {dated ? <td>{row.date ?? "—"}</td> : null}
                  <td>{row.account}</td>
                  <td className="num">{row.amount}</td>
                  <td>
                    <label className="sr-only" htmlFor={`cat-${row.rowNo}`}>
                      Category for {row.account}
                    </label>
                    <select
                      id={`cat-${row.rowNo}`}
                      value={row.category}
                      onChange={(event) => setCategory(row.rowNo, event.target.value)}
                    >
                      <option value="">Unmapped</option>
                      {CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                    {suggested ? <SuggestedBadge /> : null}
                  </td>
                  <td>{duplicate ? "Duplicate account label" : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form className="form-card" onSubmit={(event) => void ask(event)}>
        <h2>Ask about these rows</h2>
        <Field label="Question">
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should I review?"
          />
        </Field>
        <Button type="submit" disabled={action.state.pending || session.tenantId.length === 0}>
          Ask
        </Button>
        {session.tenantId.length === 0 ? (
          <p className="muted small">
            Provision a company before the kernel can accept a question.
          </p>
        ) : null}
        {answer ? (
          <p className="suggested">
            <SuggestedBadge /> {answer}
          </p>
        ) : null}
        {action.state.error ? (
          <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} />
        ) : null}
      </form>
    </section>
  );
}
