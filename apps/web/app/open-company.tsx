"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useState, type FormEvent } from "react";

import { createEntity, provisionTenant, type ApiResult, type Session } from "./books/api";
import { useAction } from "./books/hooks";
import { ErrorNotice, Field } from "./books/ui";

/** Opens a company the signed-in person owns, then creates its legal entity. */
export function OpenCompany({
  session,
  selectTenant,
}: {
  session: Session;
  selectTenant: (tenantId: string, region?: string) => Promise<ApiResult<Session>>;
}) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const legalName = name.trim();
    const functionalCurrency = currency.trim().toUpperCase();
    if (legalName.length === 0 || !/^[A-Z]{3}$/.test(functionalCurrency)) {
      setFormError("Company name and a three-letter currency are required.");
      return;
    }
    setFormError(null);
    const tenant = await action.run(() =>
      provisionTenant(session, {
        name: legalName,
        homeRegion: session.region,
        ownerActorId: session.actorId,
      }),
    );
    if (tenant === null) return;
    const opened = await selectTenant(tenant.tenantId, tenant.homeRegion);
    if (!opened.ok) {
      setFormError(opened.error.message);
      return;
    }
    const entity = await action.run(() =>
      createEntity(opened.data, { legalName, functionalCurrency }),
    );
    if (entity === null) return;
  }

  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>Open your company</h1>
          <p>
            This creates the company in <code>{session.region || "your region"}</code> and makes{" "}
            <code>{session.actorId}</code> the owner. You can then upload statements or post
            journals. The kernel keeps the books.
          </p>
        </div>
      </header>
      <form
        className="form-card"
        onSubmit={(event) => void submit(event)}
        aria-label="Open your company"
      >
        <div className="form-row">
          <Field label="Company name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="organization"
            />
          </Field>
          <Field label="Currency">
            <Input
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              className="input-medium"
              maxLength={3}
              required
            />
          </Field>
          <Button type="submit" disabled={action.state.pending}>
            {action.state.pending ? "Opening…" : "Open company"}
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
