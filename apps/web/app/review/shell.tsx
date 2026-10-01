"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListChecks, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { fetchAuthConfig, fetchSession, listCompanies, login, selectTenant } from "../studio/api";
import type { CompanyCard, SessionView } from "../studio/types";

const SessionContext = createContext<SessionView | null>(null);
const AsOfContext = createContext<{
  readonly asOf: string;
  readonly setAsOf: (value: string) => void;
} | null>(null);

export function useReviewSession(): SessionView {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Exception review is signed out");
  return session;
}

export function useReviewAsOf(): {
  readonly asOf: string;
  readonly setAsOf: (value: string) => void;
} {
  const value = useContext(AsOfContext);
  if (!value) throw new Error("Exception review header is unavailable");
  return value;
}

export function ReviewShell({
  jobId,
  children,
}: {
  readonly jobId?: string | undefined;
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionView | null | undefined>(undefined);
  const [asOf, setAsOf] = useState("—");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [companies, setCompanies] = useState<readonly CompanyCard[] | null>(null);
  const [companyBusy, setCompanyBusy] = useState(false);
  const [companyAttempt, setCompanyAttempt] = useState(0);

  useEffect(() => {
    const dark = window.localStorage.getItem("nexora-theme") === "dark";
    document.documentElement.classList.toggle("dark", dark);
    let cancelled = false;
    void fetchSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch(() => {
        if (!cancelled) {
          setNotice("The session service is unavailable.");
          setSession(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session || session.tenantId) return;
    const current = session;
    let cancelled = false;
    setCompanyBusy(true);
    setNotice(null);
    setCompanies(null);
    void (async () => {
      try {
        const listed = await listCompanies(current.csrfToken);
        if (cancelled) return;
        setCompanies(listed);
        const onlyCompany = listed.length === 1 ? listed[0] : undefined;
        if (onlyCompany) {
          const active = await selectTenant(current.csrfToken, onlyCompany.tenantId);
          if (!cancelled) setSession(active);
        }
      } catch (caught) {
        if (!cancelled) {
          setNotice(caught instanceof Error ? caught.message : "The company could not be opened.");
        }
      } finally {
        if (!cancelled) setCompanyBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, companyAttempt]);

  async function onCompany(tenantId: string) {
    if (!session || companyBusy) return;
    setCompanyBusy(true);
    setNotice(null);
    try {
      setSession(await selectTenant(session.csrfToken, tenantId));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "The company could not be opened.");
    } finally {
      setCompanyBusy(false);
    }
  }

  async function onSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice(null);
    try {
      const config = await fetchAuthConfig();
      const result = await login(
        String(form.get("actorId") ?? "").trim(),
        String(form.get("password") ?? ""),
        config.region,
      );
      if (result.kind === "session") {
        setSession(result.session);
      } else {
        setNotice("This account needs a second factor. Sign in from the studio, then return here.");
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined) {
    return (
      <div className="nx" aria-busy="true">
        <p className="pad">Loading exception review…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <main className="nx-gate">
        <form className="nx-signin" onSubmit={(event) => void onSignIn(event)}>
          <p className="nx-kicker">Nexora</p>
          <h1>Sign in to review extraction exceptions.</h1>
          <p>Resolutions stay proposals until the kernel accepts them.</p>
          <label>
            Actor
            <Input name="actorId" defaultValue="sindhu" autoComplete="username" />
          </label>
          <label>
            Password
            <Input
              name="password"
              type="password"
              defaultValue="nexora-demo-2026"
              autoComplete="current-password"
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in" : "Open the company"}
          </Button>
          {notice ? (
            <p className="nx-notice" role="alert">
              {notice}
            </p>
          ) : null}
        </form>
      </main>
    );
  }

  if (!session.tenantId) {
    return (
      <main className="nx-gate">
        <section className="nx-signin" aria-labelledby="company-title" aria-busy={companyBusy}>
          <p className="nx-kicker">Nexora</p>
          <h1 id="company-title">Choose a company</h1>
          {companyBusy ? <p role="status">Opening your company access…</p> : null}
          {companies?.length === 0 ? (
            <p>
              No companies are available for this account. Open Studio to manage company access.
            </p>
          ) : companies ? (
            <div className="flex flex-col gap-2" role="group" aria-label="Available companies">
              {companies.map((company) => (
                <Button
                  key={company.tenantId}
                  type="button"
                  variant="outline"
                  disabled={companyBusy}
                  onClick={() => void onCompany(company.tenantId)}
                >
                  {company.name}
                </Button>
              ))}
            </div>
          ) : null}
          {notice ? (
            <p className="nx-notice" role="alert">
              {notice}
            </p>
          ) : null}
          {!companyBusy && companies === null && notice ? (
            <Button type="button" onClick={() => setCompanyAttempt((attempt) => attempt + 1)}>
              Retry
            </Button>
          ) : null}
          <Link href="/studio">Go to Studio</Link>
        </section>
      </main>
    );
  }

  const uploadOn = pathname === "/review";
  const queueOn = pathname.startsWith("/review/jobs");

  return (
    <SessionContext.Provider value={session}>
      <AsOfContext.Provider value={{ asOf, setAsOf }}>
        <div className="nx review-shell">
          <aside className="nx-nav">
            <Link href="/studio" className="nx-brand">
              <span className="nx-mark">N</span>
              <span className="nx-nav-label">Nexora</span>
            </Link>
            <nav aria-label="Exception review">
              <Link
                href="/review"
                className={uploadOn ? "is-on" : ""}
                aria-current={uploadOn ? "page" : undefined}
              >
                <Upload size={16} aria-hidden="true" />
                <span className="nx-nav-label">Upload</span>
              </Link>
              {jobId ? (
                <Link
                  href={`/review/jobs/${jobId}`}
                  className={queueOn ? "is-on" : ""}
                  aria-current={queueOn ? "page" : undefined}
                >
                  <ListChecks size={16} aria-hidden="true" />
                  <span className="nx-nav-label">Exceptions</span>
                </Link>
              ) : null}
            </nav>
            <Link href="/studio">Back to studio</Link>
          </aside>
          <div className="nx-main">
            <header className="nx-top">
              <span>Actor {session.actorId}</span>
              <span>Basis: unposted extraction</span>
              <span data-testid="review-as-of">As of {asOf}</span>
            </header>
            <div className="nx-content">
              <p className="review-banner" role="note">
                <strong>Proposal.</strong> Accept, correct, remap, and not-applicable are sent as
                resolutions. This screen does not post to the ledger or calculate a model.
              </p>
              {children}
            </div>
          </div>
        </div>
      </AsOfContext.Provider>
    </SessionContext.Provider>
  );
}
