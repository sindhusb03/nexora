"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiFailure,
  askCopilot,
  decideProposal,
  fetchPlatform,
  fetchSession,
  fetchWorkspace,
  grantSupport,
  inviteMember,
  listCompanies,
  login,
  logout,
  saveForecast,
  selectTenant,
  setFlag,
  setTenantStatus,
} from "./api";
import { STUDIO_COMMANDS, type CommandItem } from "./commands";
import { Palette } from "./palette";
import {
  AdminView,
  ApprovalsView,
  BoardView,
  CashView,
  DashboardView,
  ForecastView,
  OnboardingView,
  PlatformViewScreen,
  QoeView,
  StatementsView,
  VarianceView,
} from "./studio-views";
import type { PlatformView, SessionView, Workspace } from "./types";

type Screen = "dashboard" | "onboarding" | "statements" | "forecast" | "cash" | "variance" | "qoe" | "board" | "approvals" | "admin" | "platform";

const DEMO_ACTORS = ["sindhu", "controller", "viewer", "platform-admin"] as const;

export function StudioApp() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [platform, setPlatform] = useState<PlatformView | null>(null);
  const [phase, setPhase] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [error, setError] = useState("The workspace could not be loaded.");
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [dark, setDark] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [periodIndex, setPeriodIndex] = useState(0);
  const [scenario, setScenario] = useState<"base" | "downside">("base");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [thread, setThread] = useState<readonly { readonly role: "you" | "nexora"; readonly body: string; readonly mode?: string }[]>([]);
  const [agent, setAgent] = useState("general");
  const [draft, setDraft] = useState("Explain revenue, cash, and what is still only suggested.");

  const boot = useCallback(async () => {
    setPhase("loading");
    try {
      const current = await fetchSession();
      if (!current) {
        setPhase("signed-out");
        return;
      }
      await openCompany(current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workspace could not be loaded.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("nexora-theme");
    const nextDark = stored === "dark";
    setDark(nextDark);
    document.documentElement.classList.toggle("dark", nextDark);
    void boot();
  }, [boot]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
        setCopilotOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openCompany(next: SessionView) {
    const companies = await listCompanies(next.csrfToken);
    const tenantId = next.tenantId ?? companies[0]?.tenantId ?? null;
    let active = next;
    if (tenantId && tenantId !== next.tenantId) {
      active = await selectTenant(next.csrfToken, tenantId);
    }
    setSession(active);
    if (!active.tenantId) {
      setWorkspace(null);
      setPhase("ready");
      if (active.platformAdmin) setScreen("platform");
      return;
    }
    const snapshot = await fetchWorkspace(active.csrfToken);
    setWorkspace(snapshot);
    setPeriodIndex(Math.max(0, snapshot.statements.periods.length - 1));
    setPhase("ready");
  }

  async function onSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actorId = String(form.get("actorId") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setNotice(null);
    try {
      const next = await login(actorId, password);
      await openCompany(next);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    if (session) await logout(session.csrfToken).catch(() => undefined);
    setSession(null);
    setWorkspace(null);
    setPhase("signed-out");
  }

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem("nexora-theme", next ? "dark" : "light");
  }

  function pick(id: string) {
    setPaletteOpen(false);
    if (id === "copilot") {
      setCopilotOpen(true);
      return;
    }
    if (isScreen(id)) setScreen(id);
    if (id === "platform" && session?.platformAdmin) void loadPlatform();
  }

  async function loadPlatform() {
    if (!session?.platformAdmin) return;
    try {
      setPlatform(await fetchPlatform(session.csrfToken));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Platform console failed");
    }
  }

  useEffect(() => {
    if (screen === "platform") void loadPlatform();
    // session identity is the dependency that matters; loadPlatform closes over it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, session?.actorId]);

  async function run<T>(work: () => Promise<T>, apply: (value: T) => void) {
    if (!session) return;
    setBusy(true);
    setNotice(null);
    try {
      apply(await work());
    } catch (caught) {
      setNotice(caught instanceof ApiFailure ? caught.message : "That change was not saved");
    } finally {
      setBusy(false);
    }
  }

  const commands = useMemo<readonly CommandItem[]>(
    () => STUDIO_COMMANDS.filter((command) => command.id !== "platform" || session?.platformAdmin),
    [session?.platformAdmin],
  );

  if (phase === "loading") return <StudioSkeleton />;
  if (phase === "error") {
    return (
      <main className="nx-gate">
        <h1>The company workspace did not load</h1>
        <p>{error}</p>
        <Button type="button" onClick={() => void boot()}>Try again</Button>
      </main>
    );
  }
  if (phase === "signed-out" || !session) {
    return (
      <main className="nx-gate">
        <form className="nx-signin" onSubmit={onSignIn}>
          <p className="nx-kicker">Nexora</p>
          <h1>Board-ready and deal-ready, with a person still in charge.</h1>
          <p>The kernel computes the numbers. Agents only propose. Sign in to the Nazareno Services demo.</p>
          <label>Actor
            <Input name="actorId" defaultValue="sindhu" autoComplete="username" data-testid="signin-actor" />
          </label>
          <label>Password
            <Input name="password" type="password" defaultValue="nexora-demo-2026" autoComplete="current-password" data-testid="signin-password" />
          </label>
          <Button type="submit" disabled={busy} data-testid="signin-submit">{busy ? "Signing in" : "Open the company"}</Button>
          {notice ? <p className="nx-notice" role="alert">{notice}</p> : null}
          <ul className="nx-demo-actors">
            {DEMO_ACTORS.map((actor) => <li key={actor}>{actor}</li>)}
          </ul>
        </form>
      </main>
    );
  }

  const periods = workspace?.statements.periods ?? [];
  const period = periods[periodIndex];

  return (
    <div className={`nx ${copilotOpen ? "is-copilot" : ""}`}>
      <aside className="nx-nav">
        <p className="nx-brand">Nexora</p>
        <nav>
          {commands.filter((command) => command.group !== "Actions").map((command) => (
            <button key={command.id} type="button" className={screen === command.id ? "is-on" : ""} data-testid={`nav-${command.id}`} onClick={() => pick(command.id)}>
              {command.label}
            </button>
          ))}
        </nav>
        <a href="/classic">Classic shell</a>
      </aside>
      <div className="nx-main">
        <header className="nx-top">
          <label>Company
            <select value={workspace?.context.tenantId ?? ""} data-testid="tenant-switch" onChange={() => undefined}>
              <option value={workspace?.context.tenantId ?? ""}>{workspace?.context.tenantName ?? "No company"}</option>
            </select>
          </label>
          <label>Entity
            <select value={workspace?.context.entityId ?? ""} onChange={() => undefined}>
              <option value={workspace?.context.entityId ?? ""}>{workspace?.context.entityName ?? "—"}</option>
            </select>
          </label>
          <label>Period
            <select value={period?.periodId ?? ""} data-testid="period-switch" onChange={(event) => setPeriodIndex(periods.findIndex((item) => item.periodId === event.target.value))}>
              {periods.map((item) => <option key={item.periodId} value={item.periodId}>{item.label}</option>)}
            </select>
          </label>
          <label>Scenario
            <select value={scenario} data-testid="scenario-switch" onChange={(event) => setScenario(event.target.value === "downside" ? "downside" : "base")}>
              <option value="base">Base</option>
              <option value="downside">Downside</option>
            </select>
          </label>
          <div className="nx-top-actions">
            <Button type="button" variant="outline" onClick={() => setPaletteOpen(true)} data-testid="open-palette">Search</Button>
            <Button type="button" variant="outline" onClick={toggleTheme} data-testid="theme-toggle">{dark ? "Light" : "Dark"}</Button>
            <Button type="button" onClick={() => setCopilotOpen(true)} data-testid="open-copilot">Copilot</Button>
            <button type="button" className="nx-user" onClick={() => void onSignOut()} data-testid="sign-out">{session.actorId}</button>
          </div>
        </header>
        {notice ? <p className="nx-banner" role="status">{notice}</p> : null}
        <div className="nx-content">
          {!workspace ? <p className="nx-empty">This actor has no company membership yet.</p> : null}
          {workspace && screen === "dashboard" ? <DashboardView workspace={workspace} periodIndex={periodIndex} dark={dark} /> : null}
          {workspace && screen === "onboarding" ? <OnboardingView workspace={workspace} /> : null}
          {workspace && screen === "statements" ? (
            <StatementsView workspace={workspace} periodIndex={periodIndex} onSelectPeriod={(periodId) => setPeriodIndex(periods.findIndex((item) => item.periodId === periodId))} />
          ) : null}
          {workspace && screen === "forecast" ? (
            <ForecastView
              workspace={workspace}
              dark={dark}
              busy={busy}
              onSave={(input) => void run(() => saveForecast(session.csrfToken, input), setWorkspace)}
            />
          ) : null}
          {workspace && screen === "cash" ? <CashView workspace={workspace} scenario={scenario} dark={dark} /> : null}
          {workspace && screen === "variance" ? <VarianceView workspace={workspace} dark={dark} /> : null}
          {workspace && screen === "qoe" ? <QoeView workspace={workspace} dark={dark} /> : null}
          {workspace && screen === "board" ? <BoardView workspace={workspace} /> : null}
          {workspace && screen === "approvals" ? (
            <ApprovalsView
              workspace={workspace}
              busyId={busyId}
              onDecide={(id, decision) => {
                setWorkspace({ ...workspace, approvals: workspace.approvals.map((item) => item.id === id ? { ...item, status: decision } : item) });
                setBusyId(id);
                void decideProposal(session.csrfToken, id, decision)
                  .then(setWorkspace)
                  .catch((caught: unknown) => setNotice(caught instanceof Error ? caught.message : "Decision failed"))
                  .finally(() => setBusyId(null));
              }}
            />
          ) : null}
          {workspace && screen === "admin" ? (
            <AdminView workspace={workspace} busy={busy} onInvite={(actorId, role) => void run(() => inviteMember(session.csrfToken, actorId, role), setWorkspace)} />
          ) : null}
          {screen === "platform" ? (
            <PlatformViewScreen
              platform={platform}
              busy={busy}
              onStatus={(tenantId, status) => void run(() => setTenantStatus(session.csrfToken, tenantId, status), setPlatform)}
              onFlag={(id, enabled) => {
                setPlatform((current) => current && { ...current, flags: current.flags.map((flag) => flag.id === id ? { ...flag, enabled } : flag) });
                void run(() => setFlag(session.csrfToken, id, enabled), setPlatform);
              }}
              onSupport={(tenantId, hours, reason) => void run(() => grantSupport(session.csrfToken, tenantId, hours, reason), setPlatform)}
            />
          ) : null}
        </div>
      </div>
      {copilotOpen ? (
        <CopilotDrawer
          agent={agent}
          draft={draft}
          thread={thread}
          busy={busy}
          onAgent={setAgent}
          onDraft={setDraft}
          onClose={() => setCopilotOpen(false)}
          onAsk={() => {
            if (!session || draft.trim().length === 0) return;
            const message = draft.trim();
            setThread((current) => [...current, { role: "you", body: message }]);
            setDraft("");
            setBusy(true);
            void askCopilot(session.csrfToken, message, agent)
              .then((reply) => {
                setThread((current) => [...current, { role: "nexora", body: reply.text, mode: reply.mode }]);
                if (reply.proposal) setNotice(`Suggested: ${reply.proposal.title}`);
                if (workspace) void fetchWorkspace(session.csrfToken).then(setWorkspace).catch(() => undefined);
              })
              .catch((caught: unknown) => setNotice(caught instanceof Error ? caught.message : "Copilot failed"))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
      <Palette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} onPick={pick} />
    </div>
  );
}

function CopilotDrawer({
  agent,
  draft,
  thread,
  busy,
  onAgent,
  onDraft,
  onClose,
  onAsk,
}: {
  readonly agent: string;
  readonly draft: string;
  readonly thread: readonly { readonly role: "you" | "nexora"; readonly body: string; readonly mode?: string }[];
  readonly busy: boolean;
  readonly onAgent: (agent: string) => void;
  readonly onDraft: (value: string) => void;
  readonly onClose: () => void;
  readonly onAsk: () => void;
}) {
  const agents = ["general", "mapping", "variance", "normalization", "board", "watcher"];
  return (
    <aside className="nx-drawer" data-testid="copilot-drawer">
      <header>
        <div>
          <p className="nx-kicker">Copilot</p>
          <h2>Grounded in the kernel</h2>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
      </header>
      <div className="nx-agents">
        {agents.map((name) => (
          <button key={name} type="button" className={agent === name ? "is-on" : ""} onClick={() => onAgent(name)}>{name}</button>
        ))}
      </div>
      <div className="nx-thread" data-testid="copilot-thread">
        {thread.length === 0 ? <p className="nx-muted">Numbers in the answer have to come from a tool result. Without an API key the reply is labeled mock.</p> : null}
        {thread.map((message, index) => (
          <article key={`${message.role}-${index}`} className={message.role === "you" ? "is-you" : ""}>
            <p>{message.role === "you" ? "You" : `Nexora${message.mode ? ` · ${message.mode}` : ""}`}</p>
            <pre>{message.body}</pre>
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onAsk();
        }}
      >
        <textarea value={draft} onChange={(event) => onDraft(event.target.value)} data-testid="copilot-input" />
        <Button type="submit" disabled={busy} data-testid="copilot-send">{busy ? "Thinking" : "Ask"}</Button>
      </form>
    </aside>
  );
}

function StudioSkeleton() {
  return (
    <div className="nx nx-loading" aria-busy="true" aria-label="Loading Nexora">
      <div className="nx-nav" />
      <div className="nx-main">
        <div className="nx-skel" />
        <div className="nx-skel nx-skel-lg" />
      </div>
    </div>
  );
}

function isScreen(value: string): value is Screen {
  return STUDIO_COMMANDS.some((command) => command.id === value && command.id !== "copilot");
}
