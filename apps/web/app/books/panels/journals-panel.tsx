"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Fragment, useState, type FormEvent } from "react";

import {
  listJournals,
  postJournal,
  type Account,
  type Entity,
  type Journal,
  type JournalLineInput,
  type Period,
  type Session,
} from "../api";
import { sessionKey, useAction, useResource, type Resource } from "../hooks";
import { ErrorNotice, Field, Figure, Hash, PanelHeader, ResourceView, StatusBadge } from "../ui";

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const MIN_LINES = 2;

interface DraftLine {
  readonly key: string;
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
}

function blankLine(): DraftLine {
  return { key: crypto.randomUUID(), accountId: "", debit: "", credit: "" };
}

export function JournalsPanel({
  session,
  entity,
  period,
  accounts,
}: {
  session: Session;
  entity: Entity;
  period: Period;
  accounts: Resource<readonly Account[]>;
}) {
  const journals = useResource(
    `${sessionKey(session)}|journals|${entity.entityId}|${period.periodId}`,
    () => listJournals(session, entity.entityId, period.periodId),
  );
  const [lines, setLines] = useState<readonly DraftLine[]>(() => [blankLine(), blankLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [posted, setPosted] = useState<Journal | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useAction();

  const accountRows = accounts.status === "ready" ? accounts.data : [];
  const postable = accountRows.filter((account) => account.active && account.currency === entity.functionalCurrency);
  const accountLabel = new Map(accountRows.map((account) => [account.accountId, `${account.code} · ${account.name}`]));
  const periodOpen = period.status === "open";

  function updateLine(key: string, patch: Partial<Omit<DraftLine, "key">>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payloadLines: JournalLineInput[] = [];
    for (const [index, line] of lines.entries()) {
      const debit = line.debit.trim() === "" ? "0" : line.debit.trim();
      const credit = line.credit.trim() === "" ? "0" : line.credit.trim();
      if (line.accountId === "") {
        setFormError(`Line ${index + 1}: choose an account.`);
        return;
      }
      if (!DECIMAL_PATTERN.test(debit) || !DECIMAL_PATTERN.test(credit)) {
        setFormError(`Line ${index + 1}: debit and credit must be plain decimals such as 1000.00.`);
        return;
      }
      payloadLines.push({ accountId: line.accountId, debit, credit });
    }
    setFormError(null);
    setPosted(null);
    const idempotencyKey = crypto.randomUUID();
    const result = await action.run(() =>
      postJournal(
        session,
        {
          entityId: entity.entityId,
          periodId: period.periodId,
          currency: entity.functionalCurrency,
          lines: payloadLines,
        },
        idempotencyKey,
      ),
    );
    if (result !== null) {
      setPosted(result);
      setLines([blankLine(), blankLine()]);
      journals.reload();
    }
  }

  return (
    <section className="panel">
      <PanelHeader
        title="Journals"
        description={`Posted journals for ${period.startDate} to ${period.endDate}. Posted journals are immutable; totals are computed by the kernel.`}
      />

      <ResourceView resource={journals.resource} label="journals">
        {(rows) =>
          rows.length === 0 ? (
            <p className="empty">No journals posted in this period.</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Posted at</th>
                  <th>Journal ID</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th className="num">Total debit</th>
                  <th>Currency</th>
                  <th>Payload hash</th>
                  <th>Reverses</th>
                  <th aria-label="Lines" />
                </tr>
              </thead>
              <tbody>
                {rows.map((journal) => {
                  const open = expanded === journal.journalId;
                  return (
                    <Fragment key={journal.journalId}>
                      <tr>
                        <td className="figure">{journal.postedAt ?? "—"}</td>
                        <td>
                          <Hash value={journal.journalId} />
                        </td>
                        <td>
                          <StatusBadge status="posted" />
                        </td>
                        <td className="figure">v{journal.version}</td>
                        <td className="num">
                          <Figure value={journal.totalDebit} />
                        </td>
                        <td>{journal.currency}</td>
                        <td>
                          <Hash value={journal.payloadHash} />
                        </td>
                        <td>{journal.reversesJournalId ? <Hash value={journal.reversesJournalId} /> : ""}</td>
                        <td className="cell-action">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setExpanded(open ? null : journal.journalId)}
                            aria-expanded={open}
                          >
                            {open ? "Hide lines" : "Lines"}
                          </Button>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="row-detail">
                          <td colSpan={9}>
                            <table className="grid grid-inner">
                              <thead>
                                <tr>
                                  <th>#</th>
                                  <th>Account</th>
                                  <th className="num">Debit (minor units)</th>
                                  <th className="num">Credit (minor units)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {journal.lines.map((line) => (
                                  <tr key={line.lineNo}>
                                    <td className="figure">{line.lineNo}</td>
                                    <td>{accountLabel.get(line.accountId) ?? <code className="hash">{line.accountId}</code>}</td>
                                    <td className="num">
                                      <Figure value={line.debitMinor} />
                                    </td>
                                    <td className="num">
                                      <Figure value={line.creditMinor} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <p className="muted small">
                              Kernel total debit: {journal.totalDebitMinor} minor units ({journal.totalDebit} {journal.currency})
                            </p>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )
        }
      </ResourceView>

      {posted ? (
        <div className="result-card" role="status">
          <div className="result-head">
            <StatusBadge status="posted" />
            <strong>{posted.replayed ? "Journal already posted (idempotent replay)" : "Journal posted"}</strong>
          </div>
          <dl className="kv">
            <dt>Total debit (kernel)</dt>
            <dd>
              <Figure value={posted.totalDebit} /> {posted.currency}
            </dd>
            <dt>Payload hash</dt>
            <dd>
              <code className="hash">{posted.payloadHash}</code>
            </dd>
            <dt>Journal ID</dt>
            <dd>
              <code className="hash">{posted.journalId}</code>
            </dd>
            <dt>Version</dt>
            <dd className="figure">v{posted.version}</dd>
          </dl>
        </div>
      ) : null}

      <form className="form-card" onSubmit={submit}>
        <h3>Post journal</h3>
        {!periodOpen ? (
          <p className="notice notice-info">This period is {period.status}. The kernel rejects postings into it.</p>
        ) : null}
        <p className="muted small">
          Currency is fixed to the entity functional currency ({entity.functionalCurrency}). Balance is validated by
          the kernel on submit; this form does not total the lines.
        </p>
        {accounts.status === "error" ? <ErrorNotice error={accounts.error} httpStatus={accounts.httpStatus} /> : null}
        <table className="grid grid-form">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td className="figure">{index + 1}</td>
                <td>
                  <select
                    value={line.accountId}
                    onChange={(event) => updateLine(line.key, { accountId: event.target.value })}
                    aria-label={`Line ${index + 1} account`}
                  >
                    <option value="">Choose account…</option>
                    {postable.map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  <Input
                    inputMode="decimal"
                    className="input-figure"
                    placeholder="0.00"
                    value={line.debit}
                    onChange={(event) => updateLine(line.key, { debit: event.target.value })}
                    aria-label={`Line ${index + 1} debit`}
                  />
                </td>
                <td className="num">
                  <Input
                    inputMode="decimal"
                    className="input-figure"
                    placeholder="0.00"
                    value={line.credit}
                    onChange={(event) => updateLine(line.key, { credit: event.target.value })}
                    aria-label={`Line ${index + 1} credit`}
                  />
                </td>
                <td className="cell-action">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={lines.length <= MIN_LINES}
                    onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-row">
          <Button type="button" variant="outline" onClick={() => setLines((current) => [...current, blankLine()])}>
            Add line
          </Button>
          <Field label="Currency">
            <Input value={entity.functionalCurrency} readOnly className="input-short" />
          </Field>
          <Button type="submit" disabled={action.state.pending || !periodOpen}>
            {action.state.pending ? "Posting…" : "Post journal"}
          </Button>
        </div>
        {formError ? <p className="form-error">{formError}</p> : null}
        {action.state.error ? <ErrorNotice error={action.state.error} httpStatus={action.state.httpStatus} /> : null}
      </form>
    </section>
  );
}
