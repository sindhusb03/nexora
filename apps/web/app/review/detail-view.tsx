"use client";

import { Button } from "@/components/ui/button";
import {
  canResolveIngestion,
  headerValueNotAcceptable,
  type Account,
  type Exception,
  type ExtractedValue,
  type SourceDocument,
} from "@nexora/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AcceptButton } from "./accept-action";
import { getIngestionClient } from "./client";
import {
  formatConfidence,
  formatMinor,
  newIdempotencyKey,
  severityClass,
  severityLabel,
  statusClass,
  statusLabel,
} from "./format";
import { PdfPreview } from "./pdf-preview";
import { modelProgress } from "./queue";
import { SheetPreview } from "./sheet-preview";
import { useReviewAsOf, useReviewSession } from "./shell";

type Action = "accept" | "correct" | "remap" | "not_applicable";

export function DetailView({
  jobId,
  exceptionId,
}: {
  readonly jobId: string;
  readonly exceptionId: string;
}) {
  const session = useReviewSession();
  const { setAsOf } = useReviewAsOf();
  const canResolve = canResolveIngestion(session.roles);
  const router = useRouter();
  const search = useSearchParams();
  const requested = search.get("action");
  const [exception, setException] = useState<Exception | null>(null);
  const [value, setValue] = useState<ExtractedValue | null>(null);
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [chart, setChart] = useState<readonly Account[]>([]);
  const [blockingOpen, setBlockingOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(
    canResolve && isAction(requested) ? requested : null,
  );
  const [note, setNote] = useState("");
  const [correctedMinor, setCorrectedMinor] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const client = getIngestionClient();
      const [job, exceptions, values] = await Promise.all([
        client.getJob(jobId),
        client.getExceptions(jobId),
        client.getValues(jobId),
      ]);
      if (cancelled) return;
      if (!job.ok) {
        setError(`${job.error.code}: ${job.error.message}`);
        return;
      }
      if (!exceptions.ok) {
        setError(`${exceptions.error.code}: ${exceptions.error.message}`);
        return;
      }
      if (!values.ok) {
        setError(`${values.error.code}: ${values.error.message}`);
        return;
      }
      const found = exceptions.value.find((item) => item.id === exceptionId) ?? null;
      if (!found) {
        setError("INGESTION_EXCEPTION_NOT_FOUND: This exception is not on the job.");
        return;
      }
      setException(found);
      if (headerValueNotAcceptable(found)) {
        setAction((current) => (current === "accept" ? null : current));
      }
      setValue(values.value.find((item) => item.id === found.valueIds[0]) ?? null);
      setDocument(job.value.documents.find((item) => item.id === found.documentId) ?? null);
      setChart(job.value.chart);
      setAsOf(job.value.context.asOf);
      setBlockingOpen(modelProgress(exceptions.value).blockingOpen);
    })();
    return () => {
      cancelled = true;
    };
  }, [exceptionId, jobId, setAsOf]);

  useEffect(() => {
    const heading = window.document.getElementById("exception-title");
    heading?.focus();
  }, [exceptionId]);

  const accounts = chart.filter((item) => item.entityName === document?.entityName);
  const provenance = exception?.provenance[0];

  async function submit() {
    if (!canResolve || !exception || !action || exception.status !== "open") return;
    if (action === "accept" && headerValueNotAcceptable(exception)) return;
    setBusy(true);
    setError(null);
    const result = await getIngestionClient().resolve(
      exception.id,
      {
        action,
        note: note.trim().length > 0 ? note.trim() : null,
        correctedMinor: action === "correct" ? correctedMinor : null,
        accountCode: action === "remap" ? accountCode : null,
        idempotencyKey: newIdempotencyKey(),
      },
      session.actorId,
      session.roles,
      session.csrfToken,
    );
    setBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setException(result.value);
    setAction(null);
    if (result.value.severity === "error") {
      setBlockingOpen((current) => (current === null ? current : Math.max(0, current - 1)));
    }
  }

  const correctReady = /^-?\d+$/.test(correctedMinor);
  const acceptBlocked = exception !== null && headerValueNotAcceptable(exception);
  const canSubmit =
    (action === "accept" && !acceptBlocked) ||
    action === "not_applicable" ||
    (action === "correct" && correctReady) ||
    (action === "remap" && accountCode.length > 0);

  return (
    <section className="nx-stack" data-testid="screen-detail" aria-labelledby="exception-title">
      <p>
        <Link href={`/review/jobs/${jobId}`} data-testid="back-to-queue">
          Back to queue
        </Link>
        {blockingOpen !== null ? (
          <span className="muted"> · {blockingOpen} blocking errors remaining</span>
        ) : null}
      </p>
      {error ? (
        <p className="nx-notice" role="alert">
          {error}
        </p>
      ) : null}
      {!exception || !provenance ? <p role="status">Loading exception…</p> : null}
      {exception && provenance ? (
        <>
          <header>
            <p className="nx-kicker">{exception.type}</p>
            <h1 id="exception-title" tabIndex={-1}>
              {exception.message}
            </h1>
            <p>
              <span className={severityClass(exception.severity)}>
                {severityLabel(exception.severity)}
              </span>{" "}
              <span className={statusClass(exception.status)}>{statusLabel(exception.status)}</span>{" "}
              <span className="num">Confidence {formatConfidence(exception.confidence)}</span>
            </p>
          </header>
          <div className="review-split">
            <article className="review-card">
              <h2>Extracted value</h2>
              <p className="small muted">
                {document?.entityName} · {document?.currency} ·{" "}
                {value?.periodLabel ?? "Period not detected"} · {value?.statement ?? "source"}
              </p>
              <dl className="review-figures">
                <div>
                  <dt>Expected</dt>
                  <dd className="num">
                    {formatMinor(exception.values.expected, exception.values.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Extracted actual</dt>
                  <dd className="num">
                    {formatMinor(exception.values.actual, exception.values.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Diff from extraction</dt>
                  <dd className="num">
                    {formatMinor(exception.values.diff, exception.values.currency)}
                  </dd>
                </div>
              </dl>
              {exception.resolution ? (
                <p>
                  Proposed {exception.resolution.action}:{" "}
                  <strong className="num">{exception.resolution.after ?? "—"}</strong>
                  <span className="small muted"> Not posted.</span>
                </p>
              ) : null}
              <p className="small">Raw text: {provenance.rawText}</p>
            </article>
            <article className="review-card">
              <h2>Source</h2>
              <p className="small muted">
                {provenance.fileName}
                {provenance.page ? ` · page ${provenance.page}` : ""}
                {provenance.sheet ? ` · ${provenance.sheet}` : ""}
                {provenance.row ? ` · row ${provenance.row}` : ""}
                {provenance.col ? ` · column ${provenance.col}` : ""}
              </p>
              {document?.pdfBase64 ? (
                <PdfPreview
                  pdfBase64={document.pdfBase64}
                  bbox={provenance.bbox}
                  rawText={provenance.rawText}
                  page={provenance.page ?? 1}
                />
              ) : null}
              {value?.sheetWindow ? <SheetPreview window={value.sheetWindow} /> : null}
            </article>
          </div>
          {exception.status === "open" && !canResolve ? (
            <p role="status" data-testid="resolve-denied">
              Your role can review exceptions but cannot record a resolution.
            </p>
          ) : null}
          {exception.status === "open" ? (
            <div className="review-actions">
              <AcceptButton
                exception={exception}
                canResolve={canResolve}
                selected={action === "accept"}
                onSelect={() => setAction("accept")}
              />
              <Button
                type="button"
                variant={action === "correct" ? "default" : "outline"}
                data-testid="action-correct"
                disabled={!canResolve}
                onClick={() => setAction("correct")}
              >
                Correct value
              </Button>
              <Button
                type="button"
                variant={action === "remap" ? "default" : "outline"}
                data-testid="action-remap"
                disabled={!canResolve}
                onClick={() => setAction("remap")}
              >
                Remap account
              </Button>
              <Button
                type="button"
                variant={action === "not_applicable" ? "default" : "outline"}
                data-testid="action-not-applicable"
                disabled={!canResolve}
                onClick={() => setAction("not_applicable")}
              >
                Not applicable
              </Button>
            </div>
          ) : (
            <p>This exception already has a proposal. It cannot be changed here.</p>
          )}
          {canResolve && action && exception.status === "open" ? (
            <form
              className="review-actions"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {action === "correct" ? (
                <label>
                  Proposed minor units
                  <input
                    data-testid="correct-value"
                    inputMode="numeric"
                    value={correctedMinor}
                    aria-describedby="minor-help"
                    onChange={(event) => setCorrectedMinor(event.target.value.trim())}
                  />
                  <span id="minor-help" className="small muted">
                    Integer minor units only.{" "}
                    {formatMinor(correctedMinor || null, exception.values.currency)} is the display
                    of what you typed.
                  </span>
                </label>
              ) : null}
              {action === "remap" ? (
                <label>
                  Chart of accounts
                  <select
                    data-testid="account-picker"
                    value={accountCode}
                    aria-label="Chart of accounts"
                    onChange={(event) => setAccountCode(event.target.value)}
                  >
                    <option value="">Choose an account</option>
                    {accounts.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.code} {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Note
                <textarea
                  data-testid="resolution-note"
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <Button type="submit" data-testid="confirm-resolution" disabled={!canSubmit || busy}>
                {busy ? "Saving proposal" : "Save proposal"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/review/jobs/${jobId}`)}
              >
                Cancel
              </Button>
            </form>
          ) : null}
          <section aria-labelledby="audit-title">
            <h2 id="audit-title">Audit trail</h2>
            {exception.auditTrail.length === 0 ? (
              <p className="muted">No resolutions yet.</p>
            ) : null}
            <ol className="review-audit" data-testid="audit-trail">
              {exception.auditTrail.map((entry) => (
                <li key={`${entry.at}-${entry.action}`} className="review-card">
                  <strong>
                    {statusLabel(
                      entry.action === "not_applicable" ? "not_applicable" : entry.action,
                    )}
                  </strong>
                  <span className="small muted">
                    {" "}
                    by {entry.by} at {entry.at}
                  </span>
                  <p className="num">
                    Before {entry.before ?? "—"} · After {entry.after ?? "—"}
                  </p>
                  {entry.note ? <p>{entry.note}</p> : null}
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </section>
  );
}

function isAction(value: string | null): value is Action {
  return (
    value === "accept" || value === "correct" || value === "remap" || value === "not_applicable"
  );
}
