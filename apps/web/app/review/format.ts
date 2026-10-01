import { confidenceBps } from "@nexora/contracts";

import { minorToDisplay, withCurrency } from "../studio/format";

/** Presentation only. The minor-unit string is not recalculated. */
export function formatMinor(minor: string | null, currency: string): string {
  if (minor === null) return "—";
  return withCurrency(minorToDisplay(minor), currency);
}

export function formatConfidence(value: string): string {
  const bps = confidenceBps(value);
  if (bps === null) return value;
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100).padStart(2, "0");
  return `${whole}.${fraction}%`;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function severityClass(severity: string): string {
  if (severity === "error") return "badge badge-red";
  if (severity === "warn") return "badge badge-amber";
  return "badge badge-sky";
}

export function statusClass(status: string): string {
  if (status === "open") return "badge badge-slate";
  if (status === "not_applicable") return "badge badge-neutral";
  return "badge badge-green";
}

export function statusLabel(status: string): string {
  if (status === "not_applicable") return "Not applicable";
  if (status === "open") return "Open";
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function severityLabel(severity: string): string {
  if (severity === "error") return "Error";
  if (severity === "warn") return "Warning";
  return "Info";
}
