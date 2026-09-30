import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiError, ApiResult, Session } from "./api";

export type Resource<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly httpStatus: number; readonly error: ApiError };

/**
 * Loads a resource whenever `key` changes. A null key means the prerequisites are
 * missing and the resource stays idle.
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<ApiResult<T>>,
): { readonly resource: Resource<T>; readonly reload: () => void } {
  const [resource, setResource] = useState<Resource<T>>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (key === null) {
      setResource({ status: "idle" });
      return;
    }
    let cancelled = false;
    setResource({ status: "loading" });
    void loadRef.current().then((result) => {
      if (cancelled) return;
      setResource(
        result.ok
          ? { status: "ready", data: result.data }
          : { status: "error", httpStatus: result.status, error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { resource, reload };
}

export interface ActionState {
  readonly pending: boolean;
  readonly error: ApiError | null;
  readonly httpStatus: number | null;
}

/** Runs a single write at a time and keeps the last API error for display. */
export function useAction(): {
  readonly state: ActionState;
  readonly run: <T>(action: () => Promise<ApiResult<T>>) => Promise<T | null>;
  readonly clear: () => void;
} {
  const [state, setState] = useState<ActionState>({
    pending: false,
    error: null,
    httpStatus: null,
  });

  const run = useCallback(async <T>(action: () => Promise<ApiResult<T>>): Promise<T | null> => {
    setState({ pending: true, error: null, httpStatus: null });
    const result = await action();
    if (result.ok) {
      setState({ pending: false, error: null, httpStatus: null });
      return result.data;
    }
    setState({ pending: false, error: result.error, httpStatus: result.status });
    return null;
  }, []);

  const clear = useCallback(() => setState({ pending: false, error: null, httpStatus: null }), []);
  return { state, run, clear };
}

export const SESSION_STORAGE_KEY = "nexora.session";

export const DEFAULT_SESSION: Session = { actorId: "owner-1", tenantId: "", region: "us-east-1" };

export function readStoredSession(): Session {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return DEFAULT_SESSION;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SESSION;
    const record = parsed as Record<string, unknown>;
    return {
      actorId: typeof record.actorId === "string" ? record.actorId : DEFAULT_SESSION.actorId,
      tenantId: typeof record.tenantId === "string" ? record.tenantId : DEFAULT_SESSION.tenantId,
      region: typeof record.region === "string" ? record.region : DEFAULT_SESSION.region,
    };
  } catch {
    return DEFAULT_SESSION;
  }
}

export function writeStoredSession(session: Session): void {
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory session still works.
  }
}

export interface Selection {
  readonly entityId: string | null;
  readonly periodId: string | null;
}

const SELECTION_STORAGE_KEY = "nexora.selection";

/** The entity and period last chosen for a tenant, so Books and Program open on the same context. */
export function readStoredSelection(tenantId: string): Selection {
  try {
    const raw = window.sessionStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return { entityId: null, periodId: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { entityId: null, periodId: null };
    const record = parsed as Record<string, unknown>;
    if (record.tenantId !== tenantId) return { entityId: null, periodId: null };
    return {
      entityId: typeof record.entityId === "string" ? record.entityId : null,
      periodId: typeof record.periodId === "string" ? record.periodId : null,
    };
  } catch {
    return { entityId: null, periodId: null };
  }
}

export function writeStoredSelection(tenantId: string, selection: Selection): void {
  try {
    window.sessionStorage.setItem(
      SELECTION_STORAGE_KEY,
      JSON.stringify({ tenantId, ...selection }),
    );
  } catch {
    // Selection memory is a convenience; the screen still works without it.
  }
}

/** Version ids only. Figures are always re-read from the kernel, so a checker in a new session reviews stored results. */
export interface ProgramProgress {
  readonly stateId: string | null;
  readonly publishedStateId: string | null;
  readonly valuationId: string | null;
  readonly publishedValuationId: string | null;
}

const EMPTY_PROGRESS: ProgramProgress = {
  stateId: null,
  publishedStateId: null,
  valuationId: null,
  publishedValuationId: null,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function progressKey(tenantId: string): string {
  return `nexora.program.${tenantId}`;
}

export function readProgramProgress(tenantId: string): ProgramProgress {
  try {
    const raw = window.sessionStorage.getItem(progressKey(tenantId));
    if (!raw) return EMPTY_PROGRESS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_PROGRESS;
    const record = parsed as Record<string, unknown>;
    const id = (key: keyof ProgramProgress) => {
      const value = record[key];
      return typeof value === "string" && UUID.test(value) ? value : null;
    };
    return {
      stateId: id("stateId"),
      publishedStateId: id("publishedStateId"),
      valuationId: id("valuationId"),
      publishedValuationId: id("publishedValuationId"),
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function writeProgramProgress(tenantId: string, progress: ProgramProgress): void {
  try {
    window.sessionStorage.setItem(progressKey(tenantId), JSON.stringify(progress));
  } catch {
    // Progress memory lets a checker pick up the maker's versions; the kernel remains the record.
  }
}

export function readTabParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("tab");
  } catch {
    return null;
  }
}

export function writeTabParam(tab: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // Deep links are optional.
  }
}

export function sessionKey(session: Session): string {
  return `${session.actorId}|${session.tenantId}|${session.region}`;
}
