export interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: string;
}

export const STUDIO_COMMANDS: readonly CommandItem[] = [
  { id: "dashboard", label: "Dashboard", hint: "KPIs, trend, variance", group: "Company" },
  { id: "onboarding", label: "Onboarding", hint: "Upload, map, reconciliation", group: "Company" },
  { id: "statements", label: "Statements", hint: "Three statements and journals", group: "Company" },
  { id: "forecast", label: "Forecast", hint: "Drivers and scenarios", group: "Company" },
  { id: "cash", label: "Cash forecast", hint: "13-week cash", group: "Company" },
  { id: "variance", label: "Variance", hint: "Actual versus plan", group: "Company" },
  { id: "qoe", label: "Quality of earnings", hint: "Normalization bridge", group: "Company" },
  { id: "board", label: "Board pack", hint: "Figures with lineage", group: "Company" },
  { id: "approvals", label: "Approvals", hint: "Suggested agent work", group: "Company" },
  { id: "admin", label: "Organization", hint: "Members, policy, audit", group: "Admin" },
  { id: "platform", label: "Platform", hint: "Tenants, flags, connectors", group: "Admin" },
  { id: "copilot", label: "Open copilot", hint: "Ask with citations", group: "Actions" },
];

export function filterCommands<T extends { readonly label: string; readonly hint: string }>(commands: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...commands];
  return commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(needle));
}
