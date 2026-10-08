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
import {
  canResolveIngestion,
  BULK_ACCEPT_MIN_CONFIDENCE,
  EXCEPTION_TYPES,
  HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
  headerValueNotAcceptable,
  type Exception,
  type ExtractionJob,
} from "@nexora/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { getIngestionClient, isMockIngestion } from "./client";
import {
  formatConfidence,
  formatMinor,
  newIdempotencyKey,
  severityClass,
  severityLabel,
  statusClass,
  statusLabel,
} from "./format";
import { useReviewAsOf, useReviewSession } from "./shell";
import {
  bulkCandidates,
  EMPTY_QUERY,
  modelProgress,
  moveIndex,
  queueCounts,
  selectExceptions,
  type QueueQuery,
} from "./queue";

export function QueueView({ jobId }: { readonly jobId: string }) {
  const mockMode = isMockIngestion();
  const session = useReviewSession();
  const { setAsOf } = useReviewAsOf();
  const canResolve = canResolveIngestion(session.roles);
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [exceptions, setExceptions] = useState<readonly Exception[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<QueueQuery>(EMPTY_QUERY);
  const [index, setIndex] = useState(0);
  const [armed, setArmed] = useState<"accept" | "not_applicable" | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    async function load() {
      const client = getIngestionClient();
      const current = await client.getJob(jobId);
      if (cancelled) return;
      if (!current.ok) {
        setError(`${current.error.code}: ${current.error.message}`);
        return;
      }
      setJob(current.value);
      setAsOf(current.value.context.asOf);
      if (current.value.status !== "ready") return;
      const listed = await client.getExceptions(jobId);
      if (cancelled) return;
      if (!listed.ok) {
        setError(`${listed.error.code}: ${listed.error.message}`);
        return;
      }
      setExceptions(listed.value);
      window.clearInterval(timer);
    }
    void load();
    timer = window.setInterval(() => void load(), 400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, setAsOf]);

  const documents = job?.documents ?? [];
  const rows = useMemo(
    () => (exceptions ? selectExceptions(exceptions, documents, query) : []),
    [exceptions, documents, query],
  );
  const counts = exceptions ? queueCounts(exceptions) : null;
  const progress = exceptions ? modelProgress(exceptions) : null;
  const candidates = exceptions
    ? mockMode
      ? bulkCandidates(exceptions)
      : exceptions.filter(
          (item) =>
            "apiType" in item &&
            item.apiType === "mapping_low_confidence" &&
            item.status === "open" &&
            Number(item.confidence) >= Number(BULK_ACCEPT_MIN_CONFIDENCE),
        )
    : [];
  const selected = rows[index] ?? null;

  useEffect(() => {
    if (index >= rows.length) setIndex(rows.length === 0 ? 0 : rows.length - 1);
  }, [index, rows.length]);

  useEffect(() => {
    const row = document.getElementById(selected ? `exception-${selected.id}` : "");
    row?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (helpOpen || bulkOpen) return;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      if (event.key === "?") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setArmed(null);
        setIndex((current) => moveIndex(current, 1, rows.length));
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setArmed(null);
        setIndex((current) => moveIndex(current, -1, rows.length));
        return;
      }
      if (!selected) return;
      if (event.key === "Enter") {
        event.preventDefault();
        router.push(detailPath(jobId, selected.id));
        return;
      }
      if (event.key === "c" || event.key === "r" || event.key === "a" || event.key === "n") {
        if (!canResolve) {
          event.preventDefault();
          setNotice("Your role can review exceptions but cannot record a resolution.");
          return;
        }
      }
      if (event.key === "c" || event.key === "r") {
        event.preventDefault();
        const action = event.key === "c" ? "correct" : "remap";
        router.push(`${detailPath(jobId, selected.id)}?action=${action}`);
        return;
      }
      if (event.key === "a" || event.key === "n") {
        event.preventDefault();
        const action = event.key === "a" ? "accept" : "not_applicable";
        if (selected.status !== "open") return;
        if (action === "accept" && headerValueNotAcceptable(selected)) {
          setArmed(null);
          setNotice(HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE);
          return;
        }
        if (armed === action) {
          setArmed(null);
          void resolveQuick(selected, action);
        } else {
          setArmed(action);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, bulkOpen, canResolve, helpOpen, jobId, rows.length, router, selected]);

  async function resolveQuick(item: Exception, action: "accept" | "not_applicable") {
    const result = await getIngestionClient().resolve(
      item.id,
      {
        action,
        note: null,
        correctedMinor: null,
        accountCode: null,
        idempotencyKey: newIdempotencyKey(),
      },
      session.actorId,
      session.roles,
      session.csrfToken,
    );
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setExceptions(
      (current) =>
        current?.map((existing) => (existing.id === result.value.id ? result.value : existing)) ??
        null,
    );
    if (!mockMode) {
      const current = await getIngestionClient().getJob(jobId);
      if (current.ok) setJob(current.value);
    }
    setNotice(
      mockMode
        ? action === "accept"
          ? "Acceptance recorded as a proposal. Nothing was posted."
          : "Marked not applicable. Nothing was posted."
        : "Resolution applied. The engine revalidated this job.",
    );
  }

  async function confirmBulk() {
    const result = await getIngestionClient().bulkAccept(
      {
        jobId,
        exceptionIds: candidates.map((item) => item.id),
        note: "Bulk accept of high-confidence items",
        idempotencyKey: newIdempotencyKey(),
      },
      session.actorId,
      session.roles,
      session.csrfToken,
    );
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setExceptions(result.value);
    setBulkOpen(false);
    if (!mockMode) {
      const current = await getIngestionClient().getJob(jobId);
      if (current.ok) setJob(current.value);
    }
    setNotice(
      mockMode
        ? `${candidates.length} high-confidence items accepted as proposals. Nothing was posted.`
        : "High-confidence mappings accepted. The engine revalidated this job.",
    );
  }

  function patchQuery(partial: Partial<QueueQuery>) {
    setQuery((current) => ({ ...current, ...partial }));
    setIndex(0);
    setArmed(null);
  }

  return (
    <section className="nx-stack" data-testid="screen-queue" aria-labelledby="queue-title">
      <header className="nx-page-head">
        <div>
          <h1 id="queue-title">Exception queue</h1>
          <p className="muted">Job {jobId}. Keyboard triage stays on this page.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setHelpOpen(true)}>
          Shortcuts
        </Button>
      </header>
      {job && job.status !== "ready" ? (
        <p role="status" data-testid="job-status">
          Job status: {job.status}. The queue opens when checks finish.
        </p>
      ) : null}
      {error ? (
        <p className="nx-notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" data-testid="queue-notice">
          {notice}
        </p>
      ) : null}
      {armed && selected ? (
        <p role="status" data-testid="confirm-key">
          Press {armed === "accept" ? "a" : "n"} again to{" "}
          {armed === "accept" ? "accept" : "mark not applicable"} “{selected.message}”. This records
          {mockMode
            ? "a proposal and does not post."
            : "a resolution; the engine may post after validation."}
        </p>
      ) : null}
      {progress && counts ? (
        <div className="review-progress">
          <div className="review-kpis">
            <span className="badge badge-red" data-testid="count-error">
              Error {counts.error}
            </span>
            <span className="badge badge-amber" data-testid="count-warn">
              Warning {counts.warn}
            </span>
            <span className="badge badge-sky" data-testid="count-info">
              Info {counts.info}
            </span>
            <span data-testid="resolved-count">
              {progress.resolved} of {progress.total} resolved
            </span>
            <span data-testid="blocking-remaining">
              {progress.blockingOpen} blocking errors remaining
            </span>
            <strong data-testid="model-ready">
              {mockMode
                ? progress.ready
                  ? "Model ready"
                  : "Model not ready"
                : job?.context.basis === "posted"
                  ? "Posted"
                  : "Needs review"}
            </strong>
          </div>
          <progress
            value={progress.resolved}
            max={Math.max(progress.total, 1)}
            aria-label="Resolved exceptions"
          />
          <p className="small muted">
            {mockMode
              ? "Model ready means every blocking error has a proposal. It does not mean the kernel built or posted a model."
              : "Posting status comes from the ingestion engine."}
          </p>
        </div>
      ) : null}
      <div className="review-toolbar">
        <label>
          Severity
          <select
            value={query.severity}
            aria-label="Filter by severity"
            onChange={(event) =>
              patchQuery({ severity: event.target.value as QueueQuery["severity"] })
            }
          >
            <option value="all">All severities</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>
          Type
          <select
            value={query.type}
            aria-label="Filter by type"
            onChange={(event) => patchQuery({ type: event.target.value as QueueQuery["type"] })}
          >
            <option value="all">All types</option>
            {EXCEPTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Document
          <select
            value={query.documentId}
            aria-label="Filter by document"
            onChange={(event) => patchQuery({ documentId: event.target.value })}
          >
            <option value="all">All documents</option>
            {documents.map((document) => (
              <option key={document.id} value={document.id}>
                {document.fileName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            value={query.sort}
            aria-label="Sort exceptions"
            onChange={(event) => patchQuery({ sort: event.target.value as QueueQuery["sort"] })}
          >
            <option value="severity">Severity</option>
            <option value="confidence">Confidence</option>
            <option value="type">Type</option>
            <option value="document">Document</option>
          </select>
        </label>
        <label>
          Search
          <input
            ref={searchRef}
            data-testid="exception-search"
            value={query.search}
            placeholder="Search message or source"
            aria-label="Search exceptions"
            onChange={(event) => patchQuery({ search: event.target.value })}
          />
        </label>
        <Button
          type="button"
          data-testid="bulk-accept"
          disabled={!canResolve || candidates.length === 0}
          onClick={() => setBulkOpen(true)}
        >
          Bulk-accept {candidates.length} high-confidence
        </Button>
      </div>
      <div
        ref={queueRef}
        tabIndex={0}
        data-testid="exception-queue"
        role="grid"
        aria-label="Extraction exceptions"
        aria-activedescendant={selected ? `exception-${selected.id}` : undefined}
      >
        <table className="review-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Type</th>
              <th>Exception</th>
              <th>Confidence</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, rowIndex) => {
              const fileName = documents.find(
                (document) => document.id === item.documentId,
              )?.fileName;
              return (
                <tr
                  key={item.id}
                  id={`exception-${item.id}`}
                  data-testid={`exception-${item.type}`}
                  className={rowIndex === index ? "is-selected" : undefined}
                  aria-selected={rowIndex === index}
                  onClick={() => {
                    setIndex(rowIndex);
                    setArmed(null);
                    queueRef.current?.focus();
                  }}
                >
                  <td>
                    <span className={severityClass(item.severity)}>
                      {severityLabel(item.severity)}
                    </span>
                  </td>
                  <td>{item.type}</td>
                  <td>
                    <Link href={detailPath(jobId, item.id)}>{item.message}</Link>
                    <div className="small muted">{fileName}</div>
                  </td>
                  <td className="num">{formatConfidence(item.confidence)}</td>
                  <td>
                    <span className={statusClass(item.status)}>{statusLabel(item.status)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="pad muted">No exceptions match this filter.</p> : null}
      </div>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent data-testid="shortcut-help">
          <DialogHeader>
            <DialogTitle>Keyboard triage</DialogTitle>
            <DialogDescription>Shortcuts apply when focus is outside a field.</DialogDescription>
          </DialogHeader>
          <dl className="review-shortcuts">
            <dt>
              <kbd>j</kbd> <kbd>k</kbd>
            </dt>
            <dd>Move selection</dd>
            <dt>
              <kbd>a</kbd> then <kbd>a</kbd>
            </dt>
            <dd>Accept the selected open item</dd>
            <dt>
              <kbd>n</kbd> then <kbd>n</kbd>
            </dt>
            <dd>Mark not applicable</dd>
            <dt>
              <kbd>c</kbd>
            </dt>
            <dd>Open correct</dd>
            <dt>
              <kbd>r</kbd>
            </dt>
            <dd>Open remap</dd>
            <dt>
              <kbd>/</kbd>
            </dt>
            <dd>Search</dd>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>Show this help</dd>
          </dl>
        </DialogContent>
      </Dialog>
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent data-testid="bulk-confirm">
          <DialogHeader>
            <DialogTitle>
              Bulk-accept {candidates.length} {mockMode ? "proposals" : "mappings"}
            </DialogTitle>
            <DialogDescription>
              {mockMode
                ? "Each item below is open, not an error, and at least 90% confidence. Accepting them does not post a journal. Blocking errors stay in the queue."
                : "The engine accepts eligible mappings at 90% confidence or above and then revalidates the job. Posting may follow validation."}
            </DialogDescription>
          </DialogHeader>
          <ul data-testid="bulk-list">
            {candidates.map((item) => (
              <li key={item.id}>
                {item.type}: {item.message} ({formatConfidence(item.confidence)}) expected{" "}
                {formatMinor(item.values.expected, item.values.currency)} actual{" "}
                {formatMinor(item.values.actual, item.values.currency)} diff{" "}
                {formatMinor(item.values.diff, item.values.currency)}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="bulk-confirm-submit"
              onClick={() => void confirmBulk()}
            >
              Accept these {mockMode ? "proposals" : "mappings"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function detailPath(jobId: string, exceptionId: string): string {
  return `/review/jobs/${jobId}/exceptions/${exceptionId}`;
}
