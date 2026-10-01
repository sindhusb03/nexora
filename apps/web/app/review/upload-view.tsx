"use client";

import { Button } from "@/components/ui/button";
import { mediaTypeForFileName, type ExtractionJob, type UploadFile } from "@nexora/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { getIngestionClient } from "./client";
import { newIdempotencyKey } from "./format";
import { useReviewAsOf, useReviewSession } from "./shell";
import { bytesToBase64 } from "./simple-pdf";

export function UploadView() {
  const session = useReviewSession();
  const { setAsOf } = useReviewAsOf();
  const [files, setFiles] = useState<readonly UploadFile[]>([]);
  const [localNames, setLocalNames] = useState<readonly string[]>([]);
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (!job || job.status === "ready" || job.status === "failed") return;
    const timer = window.setInterval(() => {
      void getIngestionClient()
        .getJob(job.id)
        .then((result) => {
          if (result.ok) {
            setJob(result.value);
            setAsOf(result.value.context.asOf);
          } else setError(`${result.error.code}: ${result.error.message}`);
        });
    }, 400);
    return () => window.clearInterval(timer);
  }, [job, setAsOf]);

  async function addFiles(list: FileList | readonly File[]) {
    setError(null);
    setReading(true);
    const next: UploadFile[] = [];
    const names: string[] = [];
    for (const file of list) {
      names.push(file.name);
      const mediaType = mediaTypeForFileName(file.name);
      if (!mediaType) {
        setError(`${file.name} must be an xlsx, csv, or pdf file.`);
        setReading(false);
        return;
      }
      if (file.size === 0) {
        setError(`${file.name} is empty.`);
        setReading(false);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      next.push({
        fileName: file.name,
        mediaType,
        byteLength: bytes.byteLength,
        contentBase64: bytesToBase64(bytes),
      });
    }
    setLocalNames(names);
    setFiles(next);
    setReading(false);
  }

  async function start() {
    setError(null);
    const result = await getIngestionClient().upload(
      { files: [...files], idempotencyKey: newIdempotencyKey() },
      session.csrfToken,
    );
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setJob(result.value);
    setAsOf(result.value.context.asOf);
    window.sessionStorage.setItem("nexora.review.lastJob", result.value.id);
  }

  return (
    <section className="nx-stack" data-testid="screen-upload" aria-labelledby="upload-title">
      <header className="nx-page-head">
        <div>
          <h1 id="upload-title">Upload source files</h1>
          <p className="muted">
            Drop income statements, balance sheets, or bank files. Extraction runs on the server.
            You review only the exceptions.
          </p>
        </div>
      </header>
      <div
        className={over ? "review-drop is-over" : "review-drop"}
        data-testid="drop-zone"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
        }}
      >
        <p>Drag xlsx, csv, or pdf files here, or choose them.</p>
        <label>
          <span className="sr-only">Choose financial files</span>
          <input
            data-testid="upload-input"
            type="file"
            multiple
            accept=".xlsx,.csv,.pdf,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              if (event.target.files && event.target.files.length > 0) {
                void addFiles(event.target.files);
              }
            }}
          />
        </label>
        <Button
          type="button"
          disabled={files.length === 0 || reading || job !== null}
          onClick={() => void start()}
          data-testid="start-extraction"
        >
          {reading ? "Reading files" : "Start extraction"}
        </Button>
      </div>
      {error ? (
        <p className="nx-notice" role="alert">
          {error}
        </p>
      ) : null}
      {localNames.length > 0 && !job ? (
        <ul className="review-files">
          {localNames.map((name) => (
            <li key={name} className="review-file">
              <strong>{name}</strong>
              <span className="badge badge-slate">Ready to send</span>
            </li>
          ))}
        </ul>
      ) : null}
      {job ? (
        <div className="nx-stack">
          <p data-testid="job-status" role="status">
            Job {job.id}: <strong>{job.status}</strong>
          </p>
          <ul className="review-files">
            {job.uploads.map((file) => (
              <li key={file.fileName} className="review-file">
                <span>{file.fileName}</span>
                <span className="badge badge-sky">{file.status}</span>
                <progress value={file.percent} max={100} aria-label={`${file.fileName} progress`}>
                  {file.percent}%
                </progress>
              </li>
            ))}
          </ul>
          {job.status === "ready" && job.summary ? (
            <p>
              <Link href={`/review/jobs/${job.id}`} data-testid="open-exceptions">
                Review {job.summary.exceptionCount} exceptions ({job.summary.blockingOpen} blocking)
              </Link>
            </p>
          ) : (
            <p className="muted">Waiting for the extraction job to finish checks.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
