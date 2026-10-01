"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  acceptAny,
  apiRequest,
  csrfHeaders,
  DEV_HEADERS,
  isRecord,
  setCsrfToken,
  str,
  type ApiError,
  type ApiResult,
  type Session,
} from "./books/api";
import { clearDataSource, setDataSourceIdentity } from "./data-source";
import { readStoredSession, writeStoredSession } from "./books/hooks";
import { ErrorNotice, Field } from "./books/ui";
import { AppShell, IdentityForm, identityContext, type Area } from "./shell";

/** What the API returns for a verified session. The browser never decides these values. */
export interface SignedSession {
  readonly actorId: string;
  readonly tenantId: string | null;
  readonly region: string;
  readonly roles: readonly string[];
  readonly platformAdmin: boolean;
  readonly expiresAt: string | null;
  readonly csrfToken: string;
}

interface AuthConfigView {
  readonly signupAllowed: boolean;
  readonly pinnedRegion: string | null;
}

export type IdentityState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out"; readonly notice: ApiError | null }
  | { readonly status: "ready"; readonly session: Session; readonly signed: SignedSession | null };

export interface Identity {
  readonly state: IdentityState;
  /** Switches tenant. A signed session asks the API to verify membership and region first. */
  readonly selectTenant: (tenantId: string, region?: string) => Promise<ApiResult<Session>>;
  /** Dev-header mode only: replaces the locally chosen identity. */
  readonly applyDev: (next: Session) => void;
  readonly signedIn: (signed: SignedSession) => void;
  readonly signOut: () => Promise<void>;
}

const SIGNED_OUT: Session = { actorId: "", tenantId: "", region: "" };

export const IDENTITY_TOGGLE_LABEL = DEV_HEADERS ? "Dev identity" : "Session";

export function useIdentity(): Identity {
  const [state, setState] = useState<IdentityState>({ status: "loading" });

  const adopt = useCallback((signed: SignedSession) => {
    setDataSourceIdentity(toSession(signed));
    setCsrfToken(signed.csrfToken);
    setState({ status: "ready", session: toSession(signed), signed });
  }, []);

  const signedOut = useCallback((notice: ApiError | null) => {
    clearDataSource();
    setCsrfToken(null);
    setState({ status: "signed-out", notice });
  }, []);

  useEffect(() => {
    if (DEV_HEADERS) {
      const session = readStoredSession();
      setDataSourceIdentity(session);
      setState({ status: "ready", session, signed: null });
      return;
    }
    let cancelled = false;
    void fetchSession().then((result) => {
      if (cancelled) return;
      if (result.ok) adopt(result.data);
      else signedOut(result.status === 401 ? null : result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [adopt, signedOut]);

  const applyDev = useCallback((next: Session) => {
    setDataSourceIdentity(next);
    writeStoredSession(next);
    setState({ status: "ready", session: next, signed: null });
  }, []);

  const selectTenant = useCallback(
    async (tenantId: string, region?: string): Promise<ApiResult<Session>> => {
      if (DEV_HEADERS) {
        const current = state.status === "ready" ? state.session : SIGNED_OUT;
        const next = { ...current, tenantId, region: region ?? current.region };
        applyDev(next);
        return { ok: true, status: 200, data: next };
      }
      const result = await selectSessionTenant(tenantId.length > 0 ? tenantId : null);
      if (result.ok) {
        adopt(result.data);
        return { ok: true, status: result.status, data: toSession(result.data) };
      }
      if (result.status === 401) signedOut(result.error);
      return result;
    },
    [adopt, applyDev, signedOut, state],
  );

  const signOut = useCallback(async () => {
    const headers = csrfHeaders();
    signedOut(null);
    await apiRequest({
      method: "POST",
      path: "/auth/logout",
      headers,
      decode: acceptAny,
    });
  }, [signedOut]);

  return { state, selectTenant, applyDev, signedIn: adopt, signOut };
}

/** Low-level tenant switch for multi-step flows that must finish before the screen re-renders. */
export function selectSessionTenant(tenantId: string | null): Promise<ApiResult<SignedSession>> {
  return apiRequest({
    method: "POST",
    path: "/auth/session/tenant",
    body: { tenantId },
    headers: csrfHeaders(),
    decode: decodeSignedSession,
  });
}

function fetchSession(): Promise<ApiResult<SignedSession>> {
  return apiRequest({ method: "GET", path: "/auth/session", decode: decodeSignedSession });
}

/**
 * Renders a sign-in screen until the API confirms a session, then hands the verified session to the page.
 * Without a session no kernel request is made, and the API would refuse one anyway.
 */
export function IdentityGate({
  area,
  identity,
  children,
}: {
  area: Area;
  identity: Identity;
  children: (session: Session, signed: SignedSession | null) => ReactNode;
}) {
  const { state } = identity;
  if (state.status === "loading") {
    return (
      <AppShell area={area} context={identityContext(SIGNED_OUT)}>
        <p className="muted loading">Checking session…</p>
      </AppShell>
    );
  }
  if (state.status === "signed-out") {
    return (
      <AppShell area={area} section="Sign in" context={identityContext(SIGNED_OUT)}>
        <SignInPanel notice={state.notice} onSignedIn={identity.signedIn} />
      </AppShell>
    );
  }
  return <>{children(state.session, state.signed)}</>;
}

export function SignInPanel({
  notice,
  onSignedIn,
}: {
  notice: ApiError | null;
  onSignedIn: (signed: SignedSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [config, setConfig] = useState<AuthConfigView | null>(null);
  const [actorId, setActorId] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ error: ApiError } | null>(null);

  useEffect(() => {
    void apiRequest({ method: "GET", path: "/auth/config", decode: decodeAuthConfig }).then(
      (result) => {
        if (!result.ok) return;
        setConfig(result.data);
        if (result.data.pinnedRegion) setRegion(result.data.pinnedRegion);
      },
    );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    if (mode === "signup") {
      const created = await apiRequest({
        method: "POST",
        path: "/auth/signup",
        body: { actorId, password },
        decode: acceptAny,
      });
      if (!created.ok) {
        setError({ error: created.error });
        setPending(false);
        return;
      }
    }
    const login = await apiRequest({
      method: "POST",
      path: "/auth/login",
      body: { actorId, password, region },
      decode: decodeSignedSession,
    });
    setPending(false);
    setPassword("");
    if (!login.ok) {
      setError({ error: login.error });
      return;
    }
    onSignedIn(login.data);
  }

  const signup = mode === "signup";
  return (
    <section className="panel panel-narrow">
      <header className="page-head">
        <div>
          <h1>{signup ? "Create an account" : "Sign in"}</h1>
          <p>
            The kernel takes your actor, tenant, and region from this signed session. Requests
            without a session are refused.
          </p>
        </div>
      </header>
      {notice ? <ErrorNotice error={notice} httpStatus={null} /> : null}
      <form
        className="form-card"
        onSubmit={(event) => void submit(event)}
        aria-label={signup ? "Create account" : "Sign in"}
      >
        <div className="form-row">
          <Field label="Actor ID">
            <Input
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={signup ? "new-password" : "current-password"}
              minLength={signup ? 12 : 1}
              required
            />
          </Field>
          <Field label="Region">
            <Input
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              className="input-medium"
              readOnly={Boolean(config?.pinnedRegion)}
              required
            />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? "Working…" : signup ? "Create and sign in" : "Sign in"}
          </Button>
        </div>
        {error ? <ErrorNotice error={error.error} httpStatus={null} /> : null}
        {config?.signupAllowed ? (
          <p className="muted small">
            {signup ? "Already registered?" : "New on this deployment?"}{" "}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMode(signup ? "login" : "signup")}
            >
              {signup ? "Sign in instead" : "Create an account"}
            </Button>
          </p>
        ) : config ? (
          <p className="muted small">An operator creates accounts on this deployment.</p>
        ) : null}
      </form>
    </section>
  );
}

/** The identity drawer: the signed session's controls, or the local dev identity form when dev headers are on. */
export function IdentityDrawer({ identity }: { identity: Identity }) {
  const { state } = identity;
  const [tenantId, setTenantId] = useState(state.status === "ready" ? state.session.tenantId : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ error: ApiError; status: number } | null>(null);

  if (state.status !== "ready") return null;
  if (DEV_HEADERS || !state.signed) {
    return <IdentityForm session={state.session} onApply={identity.applyDev} />;
  }
  const signed = state.signed;

  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await identity.selectTenant(tenantId.trim());
    setPending(false);
    if (!result.ok) setError({ error: result.error, status: result.status });
  }

  return (
    <form
      className="session-bar"
      onSubmit={(event) => void open(event)}
      aria-label="Signed session"
    >
      <span className="session-tag">Signed in</span>
      <span>
        <strong>{signed.actorId}</strong> <span className="muted">· {signed.region}</span>
        {signed.roles.length > 0 ? (
          <span className="muted"> · {signed.roles.join(", ")}</span>
        ) : null}
        {signed.platformAdmin ? <span className="muted"> · platform admin</span> : null}
      </span>
      <Field label="Tenant ID">
        <Input
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
          placeholder="Paste a tenant ID"
          className="input-wide"
        />
      </Field>
      <Button
        type="submit"
        disabled={
          pending || tenantId.trim().length === 0 || tenantId.trim() === (signed.tenantId ?? "")
        }
      >
        Open tenant
      </Button>
      {signed.tenantId ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void identity.selectTenant("")}
        >
          Leave tenant
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => void identity.signOut()}
      >
        Sign out
      </Button>
      {error ? <ErrorNotice error={error.error} httpStatus={error.status} /> : null}
    </form>
  );
}

function toSession(signed: SignedSession): Session {
  return { actorId: signed.actorId, tenantId: signed.tenantId ?? "", region: signed.region };
}

function decodeSignedSession(value: unknown): SignedSession | null {
  if (!isRecord(value)) return null;
  const actorId = str(value, "actorId");
  const region = str(value, "region");
  const csrfToken = str(value, "csrfToken");
  if (
    actorId === null ||
    region === null ||
    csrfToken === null ||
    typeof value.platformAdmin !== "boolean"
  )
    return null;
  const roles = Array.isArray(value.roles)
    ? value.roles.filter((role): role is string => typeof role === "string")
    : [];
  return {
    actorId,
    tenantId: str(value, "tenantId"),
    region,
    roles,
    platformAdmin: value.platformAdmin,
    expiresAt: str(value, "expiresAt"),
    csrfToken,
  };
}

function decodeAuthConfig(value: unknown): AuthConfigView | null {
  if (!isRecord(value) || typeof value.signupAllowed !== "boolean") return null;
  return { signupAllowed: value.signupAllowed, pinnedRegion: str(value, "pinnedRegion") };
}
