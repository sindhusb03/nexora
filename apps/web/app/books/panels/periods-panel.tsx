"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { useState, type FormEvent } from "react";

import { closePeriod, createPeriod, type Entity, type Period, type Session } from "../api";
import { useAction, type Resource } from "../hooks";
import { ErrorNotice, Field, PanelHeader, ResourceView, StatusBadge } from "../ui";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function PeriodsPanel({
  session,
  entity,
  periods,
  selectedPeriodId,
  onSelect,
  onChanged,
}: {
  session: Session;
  entity: Entity;
  periods: Resource<readonly Period[]>;
  selectedPeriodId: string | null;
  onSelect: (periodId: string) => void;
  onChanged: () => void;
}) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Period | null>(null);
  const createAction = useAction();
  const closeAction = useAction();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
      setFormError("Start and end dates are required in YYYY-MM-DD format.");
      return;
    }
    setFormError(null);
    const created = await createAction.run(() =>
      createPeriod(session, { entityId: entity.entityId, startDate, endDate }),
    );
    if (created !== null) {
      setStartDate("");
      setEndDate("");
      onChanged();
    }
  }

  async function confirmClose(period: Period) {
    const closed = await closeAction.run(() => closePeriod(session, period.periodId));
    if (closed !== null) {
      setConfirming(null);
      onChanged();
    }
  }

  return (
    <section className="panel">
      <PanelHeader
        title="Accounting periods"
        description={`Periods for ${entity.legalName}. Closed periods reject all postings and cannot be reopened.`}
      />

      <ResourceView resource={periods} label="periods">
        {(rows) =>
          rows.length === 0 ? (
            <p className="empty">
              No periods yet. Create an open period to start posting journals.
            </p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Status</th>
                  <th>Period ID</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((period) => {
                  const selected = period.periodId === selectedPeriodId;
                  return (
                    <tr key={period.periodId} className={selected ? "row-selected" : undefined}>
                      <td className="figure">{period.startDate}</td>
                      <td className="figure">{period.endDate}</td>
                      <td>
                        <StatusBadge status={period.status} />
                      </td>
                      <td>
                        <code className="hash">{period.periodId}</code>
                      </td>
                      <td className="cell-action">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => onSelect(period.periodId)}
                          disabled={selected}
                        >
                          {selected ? "Selected" : "Select"}
                        </Button>
                        {period.status === "open" ? (
                          <Button
                            type="button"
                            variant="danger-quiet"
                            onClick={() => {
                              closeAction.clear();
                              setConfirming(period);
                            }}
                          >
                            Close…
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        }
      </ResourceView>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Close period {confirming?.startDate} to {confirming?.endDate}?
            </DialogTitle>
            <DialogDescription>
              Closing is permanent. This period cannot be reopened. Every later posting, reversal,
              or recurring entry into it will be rejected by the kernel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(null)}
              disabled={closeAction.state.pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                if (confirming) void confirmClose(confirming);
              }}
              disabled={closeAction.state.pending || confirming === null}
            >
              {closeAction.state.pending ? "Closing…" : "Close period permanently"}
            </Button>
          </DialogFooter>
          {closeAction.state.error ? (
            <ErrorNotice
              error={closeAction.state.error}
              httpStatus={closeAction.state.httpStatus}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <form className="form-card" onSubmit={submit}>
        <h3>New period</h3>
        <div className="form-row">
          <Field label="Start date">
            <Input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </Field>
          <Field label="End date">
            <Input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={createAction.state.pending}>
            {createAction.state.pending ? "Creating…" : "Create period"}
          </Button>
        </div>
        {formError ? <p className="form-error">{formError}</p> : null}
        {createAction.state.error ? (
          <ErrorNotice
            error={createAction.state.error}
            httpStatus={createAction.state.httpStatus}
          />
        ) : null}
      </form>
    </section>
  );
}
