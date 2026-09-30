"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import Link from "next/link";
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";

import { API_URL, type Session } from "./books/api";
import { Field } from "./books/ui";

export type Area = "home" | "books" | "program";

export interface ShellSectionItem {
  readonly id: string;
  readonly label: string;
  /** When set, the item navigates instead of switching a section on this page. */
  readonly href?: string;
  /** When set, the section is locked and this text explains what unlocks it. */
  readonly lockedReason?: string | null;
  readonly meta?: ReactNode;
}

export interface ShellSectionGroup {
  readonly label: string;
  readonly items: readonly ShellSectionItem[];
}

export interface ContextItem {
  readonly label: string;
  readonly value: ReactNode;
  readonly title?: string | undefined;
}

interface KernelHealth {
  readonly status: string;
  readonly service: string;
  readonly engineVersion: string;
}

type HealthState =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly health: KernelHealth }
  | { readonly status: "down" };

const AREAS: readonly { readonly id: Area; readonly label: string; readonly href: string; readonly icon: IconName; readonly rail: boolean }[] = [
  { id: "home", label: "Insights", href: "/", icon: "home", rail: true },
  { id: "books", label: "Books", href: "/books", icon: "books", rail: false },
  { id: "program", label: "Program", href: "/program", icon: "program", rail: false },
];

let healthRequest: Promise<KernelHealth | null> | null = null;

function loadKernelHealth(): Promise<KernelHealth | null> {
  if (healthRequest === null) {
    const request = fetch("/api/kernel-health", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : null;
        return isHealth(body) ? body : null;
      })
      .catch(() => null);
    healthRequest = request;
    void request.then((health) => {
      if (health === null) healthRequest = null;
    });
  }
  return healthRequest;
}

/** Reads the kernel health endpoint so every screen can show which engine produced its figures. */
export function useKernelHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void loadKernelHealth().then((health) => {
      if (!cancelled) setState(health ? { status: "ok", health } : { status: "down" });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function AppShell({
  area,
  section,
  sections,
  activeSection,
  onSection,
  railNote,
  context,
  contextActions,
  drawer,
  inspector,
  inspectorLabel,
  children,
}: {
  area: Area;
  section?: string | undefined;
  sections?: readonly ShellSectionGroup[] | undefined;
  activeSection?: string | undefined;
  onSection?: ((id: string) => void) | undefined;
  railNote?: ReactNode;
  context: readonly ContextItem[];
  contextActions?: ReactNode;
  drawer?: ReactNode;
  inspector?: ReactNode;
  inspectorLabel?: string | undefined;
  children: ReactNode;
}) {
  const health = useKernelHealth();
  const areaInfo = AREAS.find((candidate) => candidate.id === area);

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <aside className="rail">
        <Link href="/" className="rail-brand" aria-label="Nexora overview">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span className="brand-name">
            <strong>Nexora</strong>
            <span>Financial Kernel workspace</span>
          </span>
        </Link>
        <nav className="rail-scroll" aria-label="Primary navigation">
          <p className="rail-group-label">Workspace</p>
          <ul className="rail-list">
            {AREAS.filter((candidate) => candidate.rail).map((candidate) => {
              const active = candidate.id === area && !activeSection;
              return (
                <li key={candidate.id}>
                  <Link
                    href={candidate.href}
                    className={active ? "rail-item rail-item-active" : "rail-item"}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon name={candidate.icon} />
                    <span className="rail-item-label">{candidate.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {sections?.map((group) => (
            <Fragment key={group.label}>
              <p className="rail-group-label">{group.label}</p>
              <ul className="rail-list">
                {group.items.map((item) => {
                  const active = item.id === activeSection;
                  const locked = Boolean(item.lockedReason);
                  const className = active ? "rail-item rail-item-active" : "rail-item";
                  const meta = (
                    <span className="rail-item-meta">
                      {item.meta ?? null}
                      {locked ? (
                        <>
                          <Icon name="lock" className="lock" />
                          <span className="sr-only">Locked: {item.lockedReason}</span>
                        </>
                      ) : null}
                    </span>
                  );
                  return (
                    <li key={item.id}>
                      {item.href && !locked ? (
                        <Link href={item.href} className={className} aria-current={active ? "page" : undefined}>
                          <span className="rail-item-label">{item.label}</span>
                          {meta}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className={className}
                          aria-current={active ? "page" : undefined}
                          disabled={locked}
                          title={item.lockedReason ?? undefined}
                          onClick={() => onSection?.(item.id)}
                        >
                          <span className="rail-item-label">{item.label}</span>
                          {meta}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          ))}
          {railNote ? <p className="rail-note">{railNote}</p> : null}
        </nav>
        <div className="rail-foot">
          Kernel API <code>{API_URL}</code>
        </div>
      </aside>

      <div className="app-column">
        <header className="appbar">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/">Nexora</Link>
            {areaInfo && area !== "home" ? (
              <>
                <span className="crumbs-sep" aria-hidden="true">
                  /
                </span>
                {section ? <Link href={areaInfo.href}>{areaInfo.label}</Link> : <span className="crumbs-current">{areaInfo.label}</span>}
              </>
            ) : null}
            {section ? (
              <>
                <span className="crumbs-sep" aria-hidden="true">
                  /
                </span>
                <span className="crumbs-current" aria-current="page">
                  {section}
                </span>
              </>
            ) : null}
          </nav>
          <div className="appbar-tools">
            <KernelChip state={health} />
          </div>
        </header>

        <div className="ctxbar">
          <dl className="ctx-cells" aria-label="Current context">
            {context.map((item) => (
              <div className="ctx-cell" key={item.label} title={item.title}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {contextActions ? <div className="ctx-actions">{contextActions}</div> : null}
        </div>
        {drawer ? <div className="ctx-drawer">{drawer}</div> : null}

        <div className={inspector ? "app-body app-body-inspector" : "app-body"}>
          <main id="main" className="app-main" tabIndex={-1}>
            {children}
          </main>
          {inspector ? (
            <aside className="app-inspector" aria-label={inspectorLabel ?? "Inspector"}>
              {inspector}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function InspectorSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="inspector-section">
      <h3>
        <span>{title}</span>
        {aside ?? null}
      </h3>
      {children}
    </section>
  );
}

export function EngineLine() {
  const health = useKernelHealth();
  if (health.status === "loading") return <span className="muted">Checking…</span>;
  if (health.status === "down") return <span className="figure-negative">Kernel unreachable</span>;
  return <code>{health.health.engineVersion}</code>;
}

/** Tenant, actor, and region cells shared by every screen. The tenant always comes from the session. */
export function identityContext(session: Session): readonly ContextItem[] {
  return [
    {
      label: "Tenant",
      title: session.tenantId || undefined,
      value: session.tenantId ? <code>{session.tenantId.slice(0, 8)}…</code> : <span className="ctx-empty">Not provisioned</span>,
    },
    {
      label: "Actor · Region",
      value: (
        <>
          {session.actorId || <span className="ctx-empty">Signed out</span>}
          <span className="muted">· {session.region || "no region"}</span>
        </>
      ),
    },
  ];
}

export function IdentityForm({ session, onApply }: { session: Session; onApply: (next: Session) => void }) {
  const [actorId, setActorId] = useState(session.actorId);
  const [tenantId, setTenantId] = useState(session.tenantId);
  const [region, setRegion] = useState(session.region);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply({ actorId: actorId.trim(), tenantId: tenantId.trim(), region: region.trim() });
  }

  const dirty = actorId !== session.actorId || tenantId !== session.tenantId || region !== session.region;

  return (
    <form className="session-bar" onSubmit={submit} aria-label="Development identity">
      <span className="session-tag">Dev identity</span>
      <Field label="Actor ID">
        <Input value={actorId} onChange={(event) => setActorId(event.target.value)} />
      </Field>
      <Field label="Tenant ID">
        <Input
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
          placeholder="Not provisioned"
          className="input-wide"
        />
      </Field>
      <Field label="Region">
        <Input value={region} onChange={(event) => setRegion(event.target.value)} className="input-medium" />
      </Field>
      <Button type="submit" disabled={!dirty}>
        Apply
      </Button>
      {session.tenantId.length > 0 ? (
        <Button type="button" variant="outline" onClick={() => onApply({ ...session, tenantId: "" })}>
          Clear tenant
        </Button>
      ) : null}
      <span className="muted small">
        NEXORA_DEV_HEADERS is on: x-actor-id, x-tenant-id, and x-region are sent with every kernel call. Local development only.
      </span>
    </form>
  );
}

function KernelChip({ state }: { state: HealthState }) {
  if (state.status === "loading") {
    return (
      <span className="kernel-chip">
        <span className="dot" aria-hidden="true" /> Checking kernel…
      </span>
    );
  }
  if (state.status === "down") {
    return (
      <span className="kernel-chip" role="status">
        <span className="dot dot-down" aria-hidden="true" /> Kernel unreachable
      </span>
    );
  }
  return (
    <span className="kernel-chip" title={`${state.health.service}: ${state.health.status}`}>
      <span className="dot dot-ok" aria-hidden="true" />
      Kernel {state.health.status}
      <code>{state.health.engineVersion}</code>
    </span>
  );
}

type IconName = "home" | "books" | "program" | "lock";

function Icon({ name, className }: { name: IconName; className?: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M2.5 7 8 2.5 13.5 7v6.5h-3.5V10h-4v3.5H2.5z" />
        </svg>
      );
    case "books":
      return (
        <svg {...common}>
          <path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2z" />
          <path d="M3 11.5a2 2 0 0 1 2-2h7.5M6 5.5h4" />
        </svg>
      );
    case "program":
      return (
        <svg {...common}>
          <path d="M8 2 14 5 8 8 2 5z" />
          <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common} width={12} height={12}>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      );
  }
}

function isHealth(value: unknown): value is KernelHealth {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.status === "string" && typeof record.service === "string" && typeof record.engineVersion === "string";
}
