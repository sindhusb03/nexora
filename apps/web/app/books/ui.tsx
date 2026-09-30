"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

import type { ApiError } from "./api";
import type { Resource } from "./hooks";

export function ErrorNotice({ error, httpStatus }: { error: ApiError; httpStatus: number | null }) {
  if (httpStatus === 401) {
    return (
      <div className="notice notice-locked" role="alert">
        <strong>Sign-in required</strong>
        <span className="notice-code">{error.code}</span>
        <p>{error.message}</p>
        <p className="muted">The kernel refuses requests without a valid session. Reload the page to sign in again.</p>
      </div>
    );
  }
  if (httpStatus === 403) {
    return (
      <div className="notice notice-locked" role="alert">
        <strong>Permission required</strong>
        <span className="notice-code">{error.code}</span>
        <p>{error.message}</p>
        <p className="muted">
          Your current actor cannot see this data. Nothing is shown rather than an incomplete result.
        </p>
      </div>
    );
  }
  return (
    <div className="notice notice-error" role="alert">
      <span className="notice-code">{error.code}</span>
      <p>{error.message}</p>
    </div>
  );
}

export function ResourceView<T>({
  resource,
  label,
  children,
}: {
  resource: Resource<T>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  switch (resource.status) {
    case "idle":
      return null;
    case "loading":
      return (
        <div className="card" aria-busy="true">
          <p className="muted loading small">Loading {label} from the kernel…</p>
          <span className="skeleton" style={{ width: "60%", marginTop: "0.6rem" }} />
          <span className="skeleton" style={{ width: "40%", marginTop: "0.45rem" }} />
        </div>
      );
    case "error":
      return <ErrorNotice error={resource.error} httpStatus={resource.httpStatus} />;
    case "ready":
      return <>{children(resource.data)}</>;
  }
}

const STATUS_CHIPS: Readonly<Record<string, { readonly label: string; readonly tone: string }>> = {
  draft: { label: "Draft", tone: "badge-amber" },
  validated: { label: "Validated", tone: "badge-slate" },
  review: { label: "In review", tone: "badge-sky" },
  approved: { label: "Approved", tone: "badge-teal" },
  published: { label: "Published", tone: "badge-green" },
  superseded: { label: "Superseded", tone: "badge-superseded" },
  rejected: { label: "Rejected", tone: "badge-red" },
  failed: { label: "Failed", tone: "badge-red" },
  succeeded: { label: "Succeeded", tone: "badge-green" },
  open: { label: "Open", tone: "badge-amber" },
  closed: { label: "Closed", tone: "badge-slate" },
  posted: { label: "Posted", tone: "badge-green" },
  derived: { label: "Derived", tone: "badge-green" },
};

/** Lifecycle chip for a status string returned by the kernel. Colour always travels with a label. */
export function StatusBadge({ status }: { status: string }) {
  const chip = STATUS_CHIPS[status];
  return <Badge variant="outline" className={`badge ${chip ? chip.tone : "badge-neutral"}`}>{chip ? chip.label : status}</Badge>;
}

export function SuggestedBadge() {
  return <Badge variant="outline" className="badge badge-violet">Suggested</Badge>;
}

export function Figure({ value }: { value: string }) {
  return <span className={value.startsWith("-") ? "figure figure-negative" : "figure"}>{value}</span>;
}

/** A server figure with the basis that produced it (engine version, run id, hash). */
export function MetricTile({
  label,
  value,
  unit,
  basis,
  status,
  small,
}: {
  label: string;
  value: string | null;
  unit?: string | undefined;
  basis?: ReactNode;
  status?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        <span>{label}</span>
        {status ?? null}
      </div>
      <div className={small ? "metric-value metric-value-sm" : "metric-value"}>
        {value === null ? <span className="ctx-empty">—</span> : <Figure value={value} />}
        {value !== null && unit ? <span className="metric-unit">{unit}</span> : null}
      </div>
      {basis ? <div className="metric-basis">{basis}</div> : null}
    </div>
  );
}

export function Hash({ value }: { value: string }) {
  return (
    <code className="hash" title={value}>
      {value.length > 16 ? `${value.slice(0, 16)}…` : value}
    </code>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function PanelHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <header className="panel-header">
      <div>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {action ?? null}
    </header>
  );
}
