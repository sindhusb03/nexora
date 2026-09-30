"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Field, Figure, MetricTile, StatusBadge } from "../books/ui";
import type { ReportPack, SensitivityResult, StateVersion, ValuationRun, VersionRef } from "./api";
import { WorkbenchHead } from "./workbench";

const FLOW = ["draft", "validated", "review", "approved", "published"] as const;

const TRANSITION_LABEL: Readonly<Record<string, string>> = {
  validated: "Validate",
  review: "Send to review",
  approved: "Approve",
  published: "Publish…",
};

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const MINOR_PATTERN = /^-?\d+$/;

function nextStatus(status: string): string | null {
  const index = FLOW.indexOf(status as (typeof FLOW)[number]);
  return index >= 0 && index < FLOW.length - 1 ? (FLOW[index + 1] ?? null) : null;
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function LifecycleTrack({ status }: { status: string }) {
  const index = FLOW.indexOf(status as (typeof FLOW)[number]);
  return (
    <ol className="row-actions" aria-label="Lifecycle" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {FLOW.map((step, position) => (
        <li key={step} style={{ opacity: position <= index ? 1 : 0.45 }}>
          <StatusBadge status={step} />
        </li>
      ))}
    </ol>
  );
}

function LifecycleControls({
  status,
  disabled,
  onTransition,
  onPublishRequest,
}: {
  status: string;
  disabled: boolean;
  onTransition: (to: string) => void;
  onPublishRequest: () => void;
}) {
  const next = nextStatus(status);
  if (next === null) {
    return <p className="muted small" style={{ margin: 0 }}>This version is published and immutable. Corrections need a new version.</p>;
  }
  return (
    <div className="row-actions">
      <span className="muted small">Next step</span>
      {next === "published" ? (
        <Button type="button" variant="danger-quiet" disabled={disabled} onClick={onPublishRequest}>
          {TRANSITION_LABEL.published}
        </Button>
      ) : (
        <Button type="button" disabled={disabled} onClick={() => onTransition(next)}>
          {TRANSITION_LABEL[next] ?? next}
        </Button>
      )}
    </div>
  );
}

function PublishConfirm({
  subject,
  checkerId,
  makerId,
  pending,
  onCancel,
  onConfirm,
}: {
  subject: string;
  checkerId: string;
  makerId: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sameActor = checkerId.trim() === makerId.trim();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish this {subject}?</DialogTitle>
          <DialogDescription>
            Publishing appends an immutable version signed by checker {checkerId || "—"}. The approved version stays in
            history, and corrections need a new version.
          </DialogDescription>
        </DialogHeader>
        {sameActor ? (
          <p className="notice notice-info">
            The checker matches the maker ({makerId}). The kernel refuses maker-checker violations; a different actor must
            publish.
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={pending || checkerId.trim().length === 0}>
            {pending ? "Publishing…" : `Publish as ${checkerId || "checker"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PublishPanel({
  disabled,
  canDraft,
  scopeLabel,
  currency,
  makerId,
  checkerId,
  grantActorId,
  checkerGranted,
  stateVersion,
  onDraft,
  onTransition,
  onLineage,
  onGrantChecker,
}: {
  disabled: boolean;
  canDraft: boolean;
  scopeLabel: string;
  currency: string;
  makerId: string;
  checkerId: string;
  grantActorId: string;
  checkerGranted: boolean;
  stateVersion: StateVersion | null;
  onDraft: (netIncomeMinor: string) => Promise<void>;
  onTransition: (to: string) => Promise<boolean>;
  onLineage: () => Promise<void>;
  onGrantChecker: () => Promise<void>;
}) {
  const [netIncomeMinor, setNetIncomeMinor] = useState("50000");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!MINOR_PATTERN.test(netIncomeMinor.trim())) {
      setFormError("Net income must be a whole number of minor units, for example 50000.");
      return;
    }
    setFormError(null);
    void onDraft(netIncomeMinor.trim());
  }

  const published = stateVersion?.status === "published";

  return (
    <section className="panel">
      <WorkbenchHead
        title="Financial state"
        note="The same inputs always produce one state hash. The maker drafts; a different actor publishes."
      />
      {!canDraft ? (
        <p className="notice notice-quiet">Choose an entity and a period in the context bar to draft a state for them.</p>
      ) : null}

      <form className="card" onSubmit={submit}>
        <div className="card-head">
          <h3>Draft a state</h3>
          <span className="muted small">{scopeLabel}</span>
        </div>
        <div className="form-row">
          <Field label="Net income, minor units">
            <Input
              value={netIncomeMinor}
              onChange={(event) => setNetIncomeMinor(event.target.value)}
              inputMode="numeric"
              className="input-figure"
            />
          </Field>
          <Field label="Basis">
            <Input value="us-gaap" readOnly className="input-medium" />
          </Field>
          <Field label="Currency">
            <Input value={currency} readOnly className="input-short" />
          </Field>
          <Button type="submit" disabled={disabled || !canDraft}>
            Draft state
          </Button>
        </div>
        {formError ? <p className="form-error">{formError}</p> : null}
      </form>

      {stateVersion ? (
        <div className={published ? "result-card" : "result-card result-card-draft"} role="status">
          <div className="result-head">
            <StatusBadge status={stateVersion.status} />
            <strong>Version {shortId(stateVersion.financialStateId)}</strong>
            <span className="muted small">{published ? "Published and immutable" : "Unpublished working version"}</span>
          </div>
          <dl className="kv">
            <dt>State hash</dt>
            <dd>
              <code className="hash-wrap">{stateVersion.stateHash}</code>
            </dd>
            <dt>Engine version</dt>
            <dd>{stateVersion.engineVersion ? <code>{stateVersion.engineVersion}</code> : <span className="muted">—</span>}</dd>
            <dt>Version ID</dt>
            <dd>
              <code className="hash">{stateVersion.financialStateId}</code>
            </dd>
            <dt>Supersedes</dt>
            <dd>{stateVersion.supersedesId ? <code className="hash">{stateVersion.supersedesId}</code> : <span className="muted">First version</span>}</dd>
          </dl>
          <div style={{ marginTop: "0.9rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <LifecycleTrack status={stateVersion.status} />
            <div className="row-actions">
              <LifecycleControls
                status={stateVersion.status}
                disabled={disabled}
                onTransition={(to) => void onTransition(to)}
                onPublishRequest={() => setConfirming(true)}
              />
              <Button type="button" variant="outline" disabled={disabled} onClick={() => void onLineage()}>
                Show lineage
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {confirming && stateVersion ? (
        <PublishConfirm
          subject="financial state"
          checkerId={checkerId}
          makerId={makerId}
          pending={disabled}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            if (await onTransition("published")) setConfirming(false);
          }}
        />
      ) : null}

      <div className="card">
        <div className="card-head">
          <h3>Maker and checker</h3>
          {checkerGranted ? <span className="badge badge-teal">Checker role granted</span> : null}
        </div>
        <dl className="kv">
          <dt>Maker</dt>
          <dd>{makerId}</dd>
          <dt>Checker</dt>
          <dd>{checkerId || <span className="muted">Set in the context bar</span>}</dd>
        </dl>
        <div className="row-actions" style={{ marginTop: "0.75rem" }}>
          <Button type="button" variant="outline" disabled={disabled || grantActorId.trim().length === 0} onClick={() => void onGrantChecker()}>
            Grant controller role to {grantActorId || "checker"}
          </Button>
          <span className="muted small">Needed once per tenant before the checker can publish.</span>
        </div>
      </div>
    </section>
  );
}

export interface DcfAssumptions {
  readonly currency: string;
  readonly freeCashFlows: string;
  readonly wacc: string;
  readonly terminalGrowth: string;
  readonly netDebt: string;
  readonly nonOperatingAssets: string;
  readonly otherClaims: string;
}

export const GOLDEN_ASSUMPTIONS: DcfAssumptions = {
  currency: "USD",
  freeCashFlows: "100, 110",
  wacc: "0.10",
  terminalGrowth: "0.02",
  netDebt: "200",
  nonOperatingAssets: "50",
  otherClaims: "10",
};

/** Shapes the typed assumptions into the kernel request. Every value stays a decimal string. */
export function toDcfRequest(assumptions: DcfAssumptions): { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  const freeCashFlows = assumptions.freeCashFlows
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (freeCashFlows.length === 0 || !freeCashFlows.every((value) => DECIMAL_PATTERN.test(value))) {
    return { ok: false, message: "Free cash flows must be decimals separated by commas, for example 100, 110." };
  }
  const scalars = {
    wacc: assumptions.wacc.trim(),
    terminalGrowth: assumptions.terminalGrowth.trim(),
    netDebt: assumptions.netDebt.trim(),
    nonOperatingAssets: assumptions.nonOperatingAssets.trim(),
    otherClaims: assumptions.otherClaims.trim(),
  };
  for (const [key, value] of Object.entries(scalars)) {
    if (!DECIMAL_PATTERN.test(value)) {
      return { ok: false, message: `${key} must be a plain decimal such as 0.10.` };
    }
  }
  const currency = assumptions.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, message: "Currency must be a 3-letter ISO code." };
  }
  return { ok: true, body: { currency, freeCashFlows, ...scalars } };
}

export function ValuationPanel({
  disabled,
  makerId,
  checkerId,
  run,
  version,
  sensitivity,
  onRun,
  onSensitivity,
  onTransition,
}: {
  disabled: boolean;
  makerId: string;
  checkerId: string;
  run: ValuationRun | null;
  version: VersionRef | null;
  sensitivity: SensitivityResult | null;
  onRun: (body: Record<string, unknown>) => Promise<void>;
  onSensitivity: () => Promise<void>;
  onTransition: (to: string) => Promise<boolean>;
}) {
  const [assumptions, setAssumptions] = useState<DcfAssumptions>(GOLDEN_ASSUMPTIONS);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function update(key: keyof DcfAssumptions, value: string) {
    setAssumptions((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = toDcfRequest(assumptions);
    if (!request.ok) {
      setFormError(request.message);
      return;
    }
    setFormError(null);
    void onRun(request.body);
  }

  const succeeded = run?.calculationStatus === "succeeded";
  const failed = run?.calculationStatus === "failed";
  const status = version?.status ?? "draft";
  const basis = run ? (
    <>
      Run <code title={run.calculationRunId ?? undefined}>{run.calculationRunId ? shortId(run.calculationRunId) : "—"}</code> ·{" "}
      <code>{run.engineVersion ?? "—"}</code>
    </>
  ) : null;

  return (
    <section className="panel">
      <WorkbenchHead
        title="Valuation"
        note="The DCF runs in the kernel. Enterprise value and equity value are read from the calculation run; a failed run stays unpublished. LBO is under Capital. Comparables and precedent transactions are not calculated."
      />
      <p className="muted small">
        Method: DCF on this screen. <Link href="/program?tab=capital">LBO, debt, and equity</Link> open in Capital access.
      </p>

      <form className="card" onSubmit={submit}>
        <div className="card-head">
          <h3>Assumptions</h3>
          <span className="muted small">Year-end discounting, Gordon growth terminal value</span>
        </div>
        <div className="form-row">
          <Field label="Free cash flows">
            <Input value={assumptions.freeCashFlows} onChange={(event) => update("freeCashFlows", event.target.value)} className="input-medium" />
          </Field>
          <Field label="WACC">
            <Input value={assumptions.wacc} onChange={(event) => update("wacc", event.target.value)} className="input-short" inputMode="decimal" />
          </Field>
          <Field label="Terminal growth">
            <Input value={assumptions.terminalGrowth} onChange={(event) => update("terminalGrowth", event.target.value)} className="input-short" inputMode="decimal" />
          </Field>
          <Field label="Net debt">
            <Input value={assumptions.netDebt} onChange={(event) => update("netDebt", event.target.value)} className="input-short" inputMode="decimal" />
          </Field>
          <Field label="Non-op assets">
            <Input value={assumptions.nonOperatingAssets} onChange={(event) => update("nonOperatingAssets", event.target.value)} className="input-short" inputMode="decimal" />
          </Field>
          <Field label="Other claims">
            <Input value={assumptions.otherClaims} onChange={(event) => update("otherClaims", event.target.value)} className="input-short" inputMode="decimal" />
          </Field>
          <Field label="Currency">
            <Input value={assumptions.currency} onChange={(event) => update("currency", event.target.value.toUpperCase())} className="input-short" maxLength={3} />
          </Field>
        </div>
        <div className="row-actions">
          <Button type="submit" disabled={disabled}>
            Run DCF on the kernel
          </Button>
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => setAssumptions(GOLDEN_ASSUMPTIONS)}>
            Reset to golden case
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              const golden = toDcfRequest(GOLDEN_ASSUMPTIONS);
              if (golden.ok) void onRun({ ...golden.body, wacc: "0.02", terminalGrowth: "0.02" });
            }}
          >
            Run refusal check (WACC = growth)
          </Button>
        </div>
        {formError ? <p className="form-error">{formError}</p> : null}
      </form>

      {run && failed ? (
        <div className="result-card result-card-failed" role="status">
          <div className="result-head">
            <StatusBadge status="failed" />
            <StatusBadge status={status} />
            <strong>The kernel refused this run</strong>
          </div>
          <dl className="kv">
            <dt>Code</dt>
            <dd>
              <code>{run.code ?? "—"}</code>
            </dd>
            <dt>Message</dt>
            <dd>{run.message ?? "—"}</dd>
            <dt>Run ID</dt>
            <dd>
              <code className="hash">{run.calculationRunId ?? "—"}</code>
            </dd>
            <dt>Input hash</dt>
            <dd>
              <code className="hash-wrap">{run.inputHash ?? "—"}</code>
            </dd>
          </dl>
          <p className="muted small" style={{ margin: "0.6rem 0 0" }}>
            No value is shown for a failed run, and it cannot be published.
          </p>
        </div>
      ) : null}

      {run && succeeded ? (
        <>
          <div className="metrics">
            <MetricTile label="Enterprise value" value={run.enterpriseValue} unit={run.currency ?? undefined} basis={basis} status={<StatusBadge status={status} />} />
            <MetricTile label="Equity value" value={run.equityValue} unit={run.currency ?? undefined} basis={basis} status={<StatusBadge status={status} />} />
            <MetricTile label="Terminal value" value={run.terminalValue} unit={run.currency ?? undefined} small basis="Undiscounted, from the kernel" />
            <MetricTile label="PV of terminal value" value={run.presentValueOfTerminalValue} unit={run.currency ?? undefined} small basis="Discounted, from the kernel" />
          </div>

          <div className={status === "published" ? "result-card" : "result-card result-card-draft"}>
            <div className="result-head">
              <StatusBadge status={status} />
              <strong>Valuation {version ? shortId(version.id) : shortId(run.valuationId)}</strong>
              <span className="muted small">{status === "published" ? "Published and immutable" : "Unpublished working version"}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))", gap: "1rem" }}>
              <dl className="kv">
                <dt>Run ID</dt>
                <dd>
                  <code className="hash">{run.calculationRunId ?? "—"}</code>
                </dd>
                <dt>Input hash</dt>
                <dd>
                  <code className="hash-wrap">{run.inputHash ?? "—"}</code>
                </dd>
                <dt>Engine</dt>
                <dd>
                  <code>{run.engineVersion ?? "—"}</code>
                </dd>
                <dt>Convention</dt>
                <dd>{run.convention ?? "—"}</dd>
              </dl>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th className="num">Present value ({run.currency ?? "—"})</th>
                  </tr>
                </thead>
                <tbody>
                  {run.presentValues.map((value, index) => (
                    <tr key={index}>
                      <td className="figure">t{index + 1}</td>
                      <td className="num">
                        <Figure value={value} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: "0.9rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <LifecycleTrack status={status} />
              <LifecycleControls
                status={status}
                disabled={disabled}
                onTransition={(to) => void onTransition(to)}
                onPublishRequest={() => setConfirming(true)}
              />
            </div>
          </div>

          {confirming ? (
            <PublishConfirm
              subject="valuation"
              checkerId={checkerId}
              makerId={makerId}
              pending={disabled}
              onCancel={() => setConfirming(false)}
              onConfirm={async () => {
                if (await onTransition("published")) setConfirming(false);
              }}
            />
          ) : null}

          <div className="card">
            <div className="card-head">
              <h3>Sensitivity</h3>
              <Button type="button" variant="outline" disabled={disabled} onClick={() => void onSensitivity()}>
                Shock WACC to 0.12
              </Button>
            </div>
            {sensitivity ? (
              <>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th className="num">Enterprise value</th>
                      <th className="num">Equity value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sensitivity.runs.map((row) => (
                      <tr key={row.id}>
                        <td>{row.id}</td>
                        <td className="num">
                          <Figure value={row.enterpriseValue} />
                        </td>
                        <td className="num">
                          <Figure value={row.equityValue} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small" style={{ margin: "0.5rem 0 0" }}>
                  Run <code>{sensitivity.calculationRunId ?? "—"}</code> · <code>{sensitivity.engineVersion ?? "—"}</code>. The
                  base valuation is unchanged.
                </p>
              </>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Sensitivity runs are separate calculation runs and leave the base valuation unchanged.
              </p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function BoardPanel({
  disabled,
  publishedStateId,
  publishedValuationId,
  pack,
  onFreeze,
}: {
  disabled: boolean;
  publishedStateId: string;
  publishedValuationId: string;
  pack: ReportPack | null;
  onFreeze: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const ready = publishedStateId.length > 0 && publishedValuationId.length > 0;
  return (
    <section className="panel">
      <WorkbenchHead title="Board pack" note="A pack accepts only a published statement and a published valuation. Freezing records a cutoff and a pack hash." />
      <div className="card">
        <div className="card-head">
          <h3>Inputs</h3>
          {ready ? <span className="badge badge-green">Ready to freeze</span> : <span className="badge badge-amber">Waiting for published inputs</span>}
        </div>
        <table className="grid">
          <tbody>
            <tr>
              <td>Financial state</td>
              <td>{publishedStateId ? <StatusBadge status="published" /> : <span className="badge badge-neutral">Not published</span>}</td>
              <td>{publishedStateId ? <code className="hash">{publishedStateId}</code> : <span className="muted">Publish a state first</span>}</td>
            </tr>
            <tr>
              <td>Valuation</td>
              <td>{publishedValuationId ? <StatusBadge status="published" /> : <span className="badge badge-neutral">Not published</span>}</td>
              <td>{publishedValuationId ? <code className="hash">{publishedValuationId}</code> : <span className="muted">Publish a valuation first</span>}</td>
            </tr>
          </tbody>
        </table>
        <div className="row-actions" style={{ marginTop: "0.75rem" }}>
          <Button type="button" variant="danger-quiet" disabled={disabled || !ready} onClick={() => setConfirming(true)}>
            Freeze pack…
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Freeze the board pack?</DialogTitle>
            <DialogDescription>
              The pack is published at freeze time with a data cutoff. It cannot be edited afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={disabled}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={disabled}
              onClick={async () => {
                if (await onFreeze()) setConfirming(false);
              }}
            >
              Freeze pack permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pack ? (
        <div className="result-card" role="status">
          <div className="result-head">
            <StatusBadge status={pack.status} />
            <strong>Board pack {shortId(pack.reportPackId)}</strong>
          </div>
          <dl className="kv">
            <dt>Pack hash</dt>
            <dd>
              <code className="hash-wrap">{pack.stateHash}</code>
            </dd>
            <dt>Engine</dt>
            <dd>
              <code>{pack.engineVersion ?? "—"}</code>
            </dd>
            <dt>Pack ID</dt>
            <dd>
              <code className="hash">{pack.reportPackId}</code>
            </dd>
          </dl>
        </div>
      ) : null}
    </section>
  );
}
