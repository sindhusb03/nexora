export interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: string;
}

export const NAV_GROUPS = ["Overview", "Books", "Planning", "Diligence", "Governance", "Admin"] as const;

export const STUDIO_COMMANDS: readonly CommandItem[] = [
  { id: "dashboard", label: "Dashboard", hint: "KPIs and trend", group: "Overview" },
  { id: "onboarding", label: "Onboarding", hint: "Upload, map, reconcile", group: "Books" },
  { id: "statements", label: "Statements", hint: "Three statements and journals", group: "Books" },
  { id: "forecast", label: "Forecast", hint: "Drivers and scenarios", group: "Planning" },
  { id: "cash", label: "Cash", hint: "13-week cash", group: "Planning" },
  { id: "variance", label: "Variance", hint: "Actual versus plan", group: "Planning" },
  { id: "qoe", label: "Quality of earnings", hint: "Normalization bridge", group: "Diligence" },
  { id: "board", label: "Board pack", hint: "Figures with lineage", group: "Diligence" },
  { id: "approvals", label: "Approvals", hint: "Suggested agent work", group: "Governance" },
  { id: "admin", label: "Organization", hint: "Members, policy, audit", group: "Admin" },
  { id: "platform", label: "Platform", hint: "Tenants, flags, connectors", group: "Admin" },
  { id: "copilot", label: "Open copilot", hint: "Ask with citations", group: "Actions" },
];

export function filterCommands<T extends { readonly label: string; readonly hint: string }>(commands: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...commands];
  return commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(needle));
}
