import {
  confidenceBps,
  isBulkCandidate,
  type Exception,
  type ExceptionType,
  type Severity,
} from "@nexora/contracts";

export interface QueueQuery {
  readonly severity: "all" | Severity;
  readonly type: "all" | ExceptionType;
  readonly documentId: "all" | string;
  readonly search: string;
  readonly sort: "severity" | "confidence" | "type" | "document";
}

export const EMPTY_QUERY: QueueQuery = {
  severity: "all",
  type: "all",
  documentId: "all",
  search: "",
  sort: "severity",
};

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export interface QueueCounts {
  readonly total: number;
  readonly open: number;
  readonly error: number;
  readonly warn: number;
  readonly info: number;
  readonly resolved: number;
}

export interface ModelProgress {
  readonly total: number;
  readonly resolved: number;
  readonly blockingOpen: number;
  readonly ready: boolean;
}

export function queueCounts(exceptions: readonly Exception[]): QueueCounts {
  return {
    total: exceptions.length,
    open: exceptions.filter((item) => item.status === "open").length,
    error: exceptions.filter((item) => item.severity === "error").length,
    warn: exceptions.filter((item) => item.severity === "warn").length,
    info: exceptions.filter((item) => item.severity === "info").length,
    resolved: exceptions.filter((item) => item.status !== "open").length,
  };
}

/** Ready means no open blocking error remains. It does not mean a model was posted. */
export function modelProgress(exceptions: readonly Exception[]): ModelProgress {
  const counts = queueCounts(exceptions);
  const blockingOpen = exceptions.filter(
    (item) => item.status === "open" && item.severity === "error",
  ).length;
  return {
    total: counts.total,
    resolved: counts.resolved,
    blockingOpen,
    ready: blockingOpen === 0,
  };
}

export function selectExceptions(
  exceptions: readonly Exception[],
  documents: readonly { readonly id: string; readonly fileName: string }[],
  query: QueueQuery,
): Exception[] {
  const names = new Map(documents.map((document) => [document.id, document.fileName]));
  const needle = query.search.trim().toLowerCase();
  const filtered = exceptions.filter((item) => {
    if (query.severity !== "all" && item.severity !== query.severity) return false;
    if (query.type !== "all" && item.type !== query.type) return false;
    if (query.documentId !== "all" && item.documentId !== query.documentId) return false;
    if (needle.length === 0) return true;
    const haystack = [
      item.message,
      item.type,
      item.severity,
      names.get(item.documentId) ?? "",
      ...item.provenance.map((itemProvenance) => itemProvenance.rawText),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
  return filtered.sort((left, right) => compareExceptions(left, right, query.sort, names));
}

export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}

export function bulkCandidates(exceptions: readonly Exception[]): Exception[] {
  return exceptions.filter((item) => isBulkCandidate(item));
}

function compareExceptions(
  left: Exception,
  right: Exception,
  sort: QueueQuery["sort"],
  names: ReadonlyMap<string, string>,
): number {
  if (sort === "confidence") {
    return (confidenceBps(right.confidence) ?? 0) - (confidenceBps(left.confidence) ?? 0);
  }
  if (sort === "type")
    return left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
  if (sort === "document") {
    const byName = (names.get(left.documentId) ?? "").localeCompare(
      names.get(right.documentId) ?? "",
    );
    return byName || left.type.localeCompare(right.type);
  }
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  return bySeverity || left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
}
