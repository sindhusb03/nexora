"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useState, type FormEvent } from "react";

import { createEntity, type Entity, type Session } from "../api";
import { useAction, type Resource } from "../hooks";
import { ErrorNotice, Field, PanelHeader, ResourceView } from "../ui";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function EntitiesPanel({
  session,
  entities,
  selectedEntityId,
  onSelect,
  onChanged,
}: {
  session: Session;
  entities: Resource<readonly Entity[]>;
  selectedEntityId: string | null;
  onSelect: (entityId: string) => void;
  onChanged: () => void;
}) {
  const [legalName, setLegalName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const functionalCurrency = currency.trim().toUpperCase();
    if (legalName.trim().length === 0) {
      setFormError("Legal name is required.");
      return;
    }
    if (!CURRENCY_PATTERN.test(functionalCurrency)) {
      setFormError("Functional currency must be a 3-letter ISO code, for example USD.");
      return;
    }
    setFormError(null);
    const created = await action.run(() =>
      createEntity(session, { legalName: legalName.trim(), functionalCurrency }),
    );
    if (created !== null) {
      setLegalName("");
      onChanged();
    }
  }

  return (
    <section className="panel">
      <PanelHeader
        title="Legal entities"
        description="Each entity keeps its own chart of accounts, periods, and functional currency."
      />

      <ResourceView resource={entities} label="entities">
        {(rows) =>
          rows.length === 0 ? (
            <p className="empty">No entities yet. Create the first legal entity below.</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Legal name</th>
                  <th>Currency</th>
                  <th>Retained earnings account</th>
                  <th>Entity ID</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((entity) => {
                  const selected = entity.entityId === selectedEntityId;
                  return (
                    <tr key={entity.entityId} className={selected ? "row-selected" : undefined}>
                      <td>{entity.legalName}</td>
                      <td>{entity.functionalCurrency}</td>
                      <td>
                        {entity.retainedEarningsAccountId ?? (
                          <span className="muted">Not designated</span>
                        )}
                      </td>
                      <td>
                        <code className="hash">{entity.entityId}</code>
                      </td>
                      <td className="cell-action">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => onSelect(entity.entityId)}
                          disabled={selected}
                        >
                          {selected ? "Selected" : "Select"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        }
      </ResourceView>

      <form className="form-card" onSubmit={submit}>
        <h3>New entity</h3>
        <div className="form-row">
          <Field label="Legal name">
            <Input
              value={legalName}
              onChange={(event) => setLegalName(event.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Functional currency">
            <Input
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              maxLength={3}
              className="input-short"
            />
          </Field>
          <Button type="submit" disabled={action.state.pending}>
            {action.state.pending ? "Creating…" : "Create entity"}
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
